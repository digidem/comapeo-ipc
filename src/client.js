import { createClient } from 'rpc-reflector/client.js'

import {
  MANAGER_CHANNEL_ID,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import {
  ClientClosedError,
  ProjectClosedError,
  TransportClosedError,
} from './errors.js'

/** @import { ClientApi, MessagePortLike } from 'rpc-reflector' */
/** @import { MapeoProject, MapeoManager } from '@comapeo/core' */
/** @import { ComapeoServicesApi } from './server.js' */

// rpc-reflector dispatches these EventEmitter methods locally and
// synchronously (they return the client/an array/a number, never a promise).
// Mirrors the method set rpc-reflector treats specially (`prop in
// EventEmitter.prototype`).
const EMITTER_METHODS = new Set([
  'addListener',
  'on',
  'once',
  'removeListener',
  'off',
  'removeAllListeners',
  'emit',
  'eventNames',
  'listeners',
  'listenerCount',
])

/**
 * Build the Proxy returned for a closed client/project reference. Method calls
 * (including nested namespaces such as `project.observation.*`) reject with
 * `makeError()`, keeping the `Promise`-returning contract callers expect.
 * EventEmitter methods are the exception: callers don't await them, so a
 * rejected promise would surface as an unhandled rejection — they throw
 * synchronously instead, at the call site.
 *
 * @param {() => Error} makeError
 */
function createClosedProxy(makeError) {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get(_target, prop) {
      if (typeof prop === 'string' && EMITTER_METHODS.has(prop)) {
        return () => {
          throw makeError()
        }
      }
      return new Proxy(function () {}, handler)
    },
    has() {
      return true
    },
    apply() {
      return Promise.reject(makeError())
    },
  }
  return new Proxy({}, handler)
}

/**
 * @typedef {ClientApi<MapeoProject>} ComapeoProjectClientApi
 */

/**
 * @typedef {ClientApi<
 *   Omit<
 *     MapeoManager,
 *     'getProject'
 *   > & {
 *     getProject: (projectPublicId: string) => Promise<ComapeoProjectClientApi>
 *   }
 * >} ComapeoCoreClientApi */

const CLOSE = Symbol('close')
const TRANSPORT_RESET = Symbol('transportReset')

/**
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {ComapeoCoreClientApi}
 */
export function createComapeoCoreClient(messagePort, opts = {}) {
  /**
   * projectPublicId → wrapper bound to a specific instance id. Only returned
   * after the server confirms that instance is still current — the server
   * can close a project without the client asking (e.g. `leaveProject`).
   * @type {Map<string, {
   *   instanceId: string,
   *   wrapper: ClientApi<MapeoProject>,
   * }>}
   */
  const currentProjectClients = new Map()

  /**
   * projectPublicId → in-flight `getProject`. Dedupes concurrent calls;
   * entries are removed on settle so later calls re-validate.
   * @type {Map<string, Promise<ClientApi<MapeoProject>>>}
   */
  const pendingProjectClients = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every currently-open
   * project. Entries are removed when the project's wrapped `close()`
   * settles; `closeComapeoCoreClient` sweeps whatever is left.
   * @type {Set<{
   *   client: ClientApi<MapeoProject>,
   *   channel: SubChannel,
   *   hardClose: (error: Error) => void,
   * }>}
   */
  const openProjectClients = new Set()

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const projectRoutingChannel = new SubChannel(messagePort, PROJECT_ROUTING_ID)

  /** @type {ClientApi<MapeoManager>} */
  const managerClient = createClient(managerChannel, opts)
  /** @type {ClientApi<import('./server.js').ProjectRoutingApi>} */
  const projectRoutingClient = createClient(projectRoutingChannel, opts)

  projectRoutingChannel.start()
  managerChannel.start()

  // Set once `closeComapeoCoreClient` has torn the whole client down. Read by the
  // manager proxy and the per-project wrappers so that calls after close
  // surface `ManagerClosedError` instead of rpc-reflector's `ChannelClosed`.
  let clientClosed = false
  const managerClosedProxy = createClosedProxy(() => new ClientClosedError())

  // Bumped on every transport reset so a `getProject` whose routing response
  // arrived just before the reset cannot cache a wrapper bound to the dead
  // server (see `resolveProjectClient`).
  let resetGeneration = 0

  function handleTransportReset() {
    if (clientClosed) return
    resetGeneration++

    // Fail in-flight calls fast with a distinguishable, retryable error
    // instead of leaving them to hit the per-call timeout.
    createClient.rejectPending(managerClient, new TransportClosedError())
    createClient.rejectPending(projectRoutingClient, new TransportClosedError())
    // The restarted server has lost every event subscription; replay them.
    createClient.resubscribe(managerClient)
    createClient.resubscribe(projectRoutingClient)

    // Project instance ids are minted by a counter that restarts with the
    // server, so a restarted server can mint an id equal to the one a cached
    // wrapper is bound to — the instance-id currency check in
    // `resolveProjectClient` could then falsely pass. Hard-close every
    // wrapper and drop the cache so `getProject` always builds a fresh
    // wrapper against the new server.
    for (const entry of openProjectClients) {
      entry.hardClose(new TransportClosedError())
    }
    openProjectClients.clear()
    currentProjectClients.clear()
  }

  const client = new Proxy(managerClient, {
    get(target, prop, receiver) {
      if (prop === CLOSE) {
        return async () => {
          managerChannel.close()
          createClient.close(managerClient)

          // Wait for any in-flight project creations to settle before
          // closing project clients. `openProjectClients` is populated
          // synchronously after `assertProjectExists` resolves, so any
          // creation that hasn't settled yet isn't in the registry.
          await Promise.allSettled(pendingProjectClients.values())

          for (const entry of openProjectClients) {
            createClient.close(entry.client)
            entry.channel.close()
          }
          openProjectClients.clear()

          // Closed last so in-flight `assertProjectExists` calls awaited
          // above can complete rather than reject.
          projectRoutingChannel.close()
          createClient.close(projectRoutingClient)

          clientClosed = true
        }
      }

      if (prop === TRANSPORT_RESET) {
        return handleTransportReset
      }

      if (prop === 'getProject') {
        return createProjectClient
      }

      // `then` must stay falsy so awaiting the client (a thenable check) does
      // not route into the throwing proxy.
      if (clientClosed && prop !== 'then') {
        return Reflect.get(managerClosedProxy, prop)
      }

      return Reflect.get(target, prop, receiver)
    },
  })

  // TS can't know the type of the proxy, so we cast it in the function return
  return /** @type {any} */ (client)

  /**
   * @param {string} projectPublicId
   * @returns {Promise<ComapeoProjectClientApi>}
   */
  async function createProjectClient(projectPublicId) {
    // Checked before the cache lookup so `getProject` rejects uniformly after
    // close — whether or not this id was fetched (and cached) earlier.
    if (clientClosed) throw new ClientClosedError()

    const pending = pendingProjectClients.get(projectPublicId)
    if (pending) return pending

    const promise = resolveProjectClient(projectPublicId)
    pendingProjectClients.set(projectPublicId, promise)
    try {
      return await promise
    } finally {
      pendingProjectClients.delete(projectPublicId)
    }
  }

  /**
   * Return the cached wrapper only if the server confirms its instance id is
   * still current; otherwise build a fresh one. The server evicts its routing
   * entry synchronously on close, so this is correct even before the close
   * event reaches this client.
   *
   * @param {string} projectPublicId
   * @returns {Promise<ClientApi<MapeoProject>>}
   */
  async function resolveProjectClient(projectPublicId) {
    const generation = resetGeneration
    const instanceId =
      await projectRoutingClient.assertProjectExists(projectPublicId)

    // A reset can land between the routing response arriving and this
    // continuation running; a wrapper minted now would be bound to the dead
    // server, so reject like any other call in flight during the reset.
    if (generation !== resetGeneration) throw new TransportClosedError()

    const current = currentProjectClients.get(projectPublicId)
    if (current && current.instanceId === instanceId) return current.wrapper

    const wrapper = createProjectClientWrapper(projectPublicId, instanceId)
    currentProjectClients.set(projectPublicId, { instanceId, wrapper })
    return wrapper
  }

  /**
   * @param {string} projectPublicId
   * @param {string} instanceId
   * @returns {ClientApi<MapeoProject>}
   */
  function createProjectClientWrapper(projectPublicId, instanceId) {
    // Per-project messages are scoped to the current open instance, not the
    // project's public id. If this project is closed and re-opened later,
    // `assertProjectExists` returns a different instance id, so the new
    // wrapper uses a fresh SubChannel that can't collide with the old one.
    const projectChannel = new SubChannel(messagePort, instanceId)

    /** @type {ClientApi<MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    // Wrap projectClient to intercept `close`: after the wire close settles,
    // tear down the local client + channel — rejecting any in-flight calls.
    // Cache eviction is in the 'close' listener below, which also covers
    // manager-initiated closes.
    // Further method calls on this wrapper reject with `ProjectClosedError`.
    // The close promise is cached so repeated `close()` calls return the
    // same result instead of failing on the already-closed channel. All
    // other property accesses delegate to the inner client unchanged.
    /** @type {Promise<void> | null} */
    let closePromise = null
    let closed = false
    // After this reference is closed, any method (including nested namespaces)
    // throws a descriptive error rather than rpc-reflector's `ChannelClosed`:
    // `ProjectClosedError` when this project was closed, `ManagerClosedError`
    // when the whole client was torn down. In-flight calls at close time are
    // left to reject with `ChannelClosed` — they were already on the wire.
    const closedProxy = createClosedProxy(() =>
      closed ? new ProjectClosedError() : new ClientClosedError(),
    )

    const registryEntry = {
      client: projectClient,
      channel: projectChannel,
      // Local-only teardown for a transport reset: the server this instance
      // belonged to is gone, so there is no wire close to await. Stale
      // references then behave like a closed project (`ProjectClosedError`),
      // and `close()` on them resolves like an already-closed project.
      hardClose: (/** @type {Error} */ error) => {
        createClient.rejectPending(projectClient, error)
        createClient.close(projectClient)
        projectChannel.close()
        closed = true
        closePromise = Promise.resolve()
      },
    }
    openProjectClients.add(registryEntry)

    const wrappedProjectClient = new Proxy(projectClient, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return () => {
            closePromise ??= (async () => {
              try {
                await target.close()
              } finally {
                createClient.close(projectClient)
                projectChannel.close()
              }
            })()
            return closePromise
          }
        }
        if ((closed || clientClosed) && prop !== 'then') {
          return Reflect.get(closedProxy, prop)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    wrappedProjectClient.once('close', () => {
      closed = true
      // A late close event must not evict a newer wrapper cached for the
      // re-opened instance.
      const current = currentProjectClients.get(projectPublicId)
      if (current?.wrapper === wrappedProjectClient) {
        currentProjectClients.delete(projectPublicId)
      }
      openProjectClients.delete(registryEntry)
    })
    return wrappedProjectClient
  }
}

/**
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 * @returns {Promise<void>}
 */
export async function closeComapeoCoreClient(client) {
  // @ts-expect-error
  return client[CLOSE]()
}

/**
 * Notify the core client that the underlying transport dropped and has
 * reconnected to a restarted server (e.g. Android killed and restarted the
 * foreground service hosting the server). Call after the transport is back
 * up. This:
 *
 * - rejects every call that was in flight with `TransportClosedError`
 *   (`code: 'RPC_TRANSPORT_CLOSED'`), so callers can fail fast and retry
 *   instead of waiting for the per-call timeout;
 * - re-sends event subscriptions for the manager, which the restarted server
 *   had lost;
 * - hard-closes every open project client and drops the project cache, so a
 *   later `getProject` builds a fresh wrapper against the new server. Stale
 *   project references held by the app behave like closed projects
 *   (`ProjectClosedError`). A `getProject` in flight during the reset
 *   rejects with `TransportClosedError`.
 *
 * No-op after `closeComapeoCoreClient`.
 *
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 * @returns {void}
 */
export function notifyCoreClientTransportReset(client) {
  // @ts-expect-error
  return client[TRANSPORT_RESET]()
}

/**
 * @typedef {ClientApi<ComapeoServicesApi>} ComapeoServicesClientApi
 */

/**
 * Create a client for the app-provided services that live outside
 * `@comapeo/core` — the map server today, and the blob and icon servers in the
 * future (once extracted from core). The host app implements the server side;
 * see {@link ComapeoServicesApi}.
 *
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 * @return {ComapeoServicesClientApi}
 */
export function createComapeoServicesClient(messagePort, opts = {}) {
  const servicesChannel = new SubChannel(messagePort, SERVICES_ID)
  const servicesClient = /** @type {ComapeoServicesClientApi} */ (
    createClient(servicesChannel, opts)
  )
  servicesChannel.start()
  return servicesClient
}

/**
 * Close the services client (removes listeners but does not close the message port)
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 */
export function closeComapeoServicesClient(servicesClient) {
  createClient.close(servicesClient)
}

/**
 * Notify the services client that the underlying transport dropped and has
 * reconnected to a restarted server: rejects every call that was in flight
 * with `TransportClosedError` (`code: 'RPC_TRANSPORT_CLOSED'`) and re-sends
 * event subscriptions the restarted server had lost. No-op after
 * `closeComapeoServicesClient`.
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 * @returns {void}
 */
export function notifyServicesClientTransportReset(servicesClient) {
  createClient.rejectPending(servicesClient, new TransportClosedError())
  createClient.resubscribe(servicesClient)
}
