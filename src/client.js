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

// Removing a listener from a client that is already dead is correct teardown
// behaviour (e.g. React effect cleanup running against a stale reference), so
// unlike the other emitter methods these must not throw on a closed proxy.
const EMITTER_UNSUBSCRIBE_METHODS = new Set([
  'removeListener',
  'off',
  'removeAllListeners',
])

/**
 * Build the Proxy returned for a closed client/project reference. Method calls
 * (including nested namespaces such as `project.observation.*`) reject with
 * `makeError()`, keeping the `Promise`-returning contract callers expect.
 * EventEmitter methods are the exception: callers don't await them, so a
 * rejected promise would surface as an unhandled rejection — they throw
 * synchronously instead, at the call site. Unsubscribe methods are a further
 * exception: they are no-ops that return the proxy for chaining, because
 * removing a listener from a dead client is valid teardown, not a bug.
 *
 * @param {() => Error} makeError
 */
function createClosedProxy(makeError) {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get(_target, prop) {
      if (typeof prop === 'string' && EMITTER_METHODS.has(prop)) {
        if (EMITTER_UNSUBSCRIBE_METHODS.has(prop)) {
          return () => proxy
        }
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
  const proxy = new Proxy({}, handler)
  return proxy
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
const RESUBSCRIBE = Symbol('resubscribe')

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
    // instead of leaving them to hit the per-call timeout. Resubscription is
    // deliberately NOT done here: at drop time the transport is down, and
    // each ON frame written into it can nudge the native transport into
    // retrying forever while the server stays down. The consumer calls
    // `resubscribeCoreClient` once the transport is back up.
    createClient.rejectPending(managerClient, new TransportClosedError())
    createClient.rejectPending(projectRoutingClient, new TransportClosedError())

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

  function handleResubscribe() {
    // rpc-reflector's resubscribe is a no-op on a closed client, and the
    // server ignores duplicate ON messages, so this is safe to call
    // repeatedly and after close.
    if (clientClosed) return
    createClient.resubscribe(managerClient)
    createClient.resubscribe(projectRoutingClient)
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

      if (prop === RESUBSCRIBE) {
        return handleResubscribe
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
        // Fire 'close' listeners (the app's teardown listeners and the
        // cache-eviction listener below) before closing the client, matching
        // what a server-initiated close delivers. Emitted before close so a
        // `.off` called from inside a close listener hits a still-open
        // client (a harmless OFF frame into a dead socket) rather than
        // throwing.
        createClient.emitLocal(projectClient, 'close')
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
 * Notify the core client that the underlying transport has dropped (e.g.
 * Android killed the foreground service hosting the server). Call at drop
 * time — the transport does not need to be back up. This:
 *
 * - rejects every call that was in flight with `TransportClosedError`
 *   (`code: 'RPC_TRANSPORT_CLOSED'`), so callers can fail fast and retry
 *   instead of waiting for the per-call timeout;
 * - hard-closes every open project client (each fires its `'close'` event
 *   locally, so app-held `once('close')` teardown listeners run) and drops
 *   the project cache, so a later `getProject` builds a fresh wrapper
 *   against the new server. Stale project references held by the app behave
 *   like closed projects (`ProjectClosedError`), except that removing
 *   listeners from them is a harmless no-op. A `getProject` in flight during
 *   the reset rejects with `TransportClosedError`.
 *
 * This deliberately does NOT replay event subscriptions: writing into a
 * still-down transport can keep nudging it into a hot retry loop. Once the
 * transport has reconnected to the restarted server, call
 * {@link resubscribeCoreClient} to restore subscriptions.
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
 * Re-send the core client's event subscriptions (manager events and project
 * routing) after the transport has reconnected to a restarted server, which
 * lost all subscription state. Call once the transport is back up, after
 * having called `notifyCoreClientTransportReset` at drop time. Safe to call
 * repeatedly (the server ignores duplicate subscriptions); no-op after
 * `closeComapeoCoreClient`.
 *
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 * @returns {void}
 */
export function resubscribeCoreClient(client) {
  // @ts-expect-error
  return client[RESUBSCRIBE]()
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
 * Notify the services client that the underlying transport has dropped:
 * rejects every call that was in flight with `TransportClosedError`
 * (`code: 'RPC_TRANSPORT_CLOSED'`). Call at drop time. Like
 * {@link notifyCoreClientTransportReset} this does not replay event
 * subscriptions — call {@link resubscribeServicesClient} once the transport
 * has reconnected. No-op after `closeComapeoServicesClient`.
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 * @returns {void}
 */
export function notifyServicesClientTransportReset(servicesClient) {
  createClient.rejectPending(servicesClient, new TransportClosedError())
}

/**
 * Re-send the services client's event subscriptions after the transport has
 * reconnected to a restarted server, which lost all subscription state. Call
 * once the transport is back up, after having called
 * `notifyServicesClientTransportReset` at drop time. Safe to call repeatedly
 * (the server ignores duplicate subscriptions); no-op after
 * `closeComapeoServicesClient`.
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 * @returns {void}
 */
export function resubscribeServicesClient(servicesClient) {
  createClient.resubscribe(servicesClient)
}
