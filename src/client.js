import { createClient } from 'rpc-reflector/client.js'

import {
  MANAGER_CHANNEL_ID,
  PROJECT_CHANNEL_PREFIX,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { ClientClosedError, TransportClosedError } from './errors.js'

/** @import { ClientApi, MessagePortLike } from 'rpc-reflector' */
/** @import { MapeoProject, MapeoManager } from '@comapeo/core' */
/** @import { ComapeoServicesApi } from './server.js' */

// rpc-reflector dispatches these EventEmitter methods locally and
// synchronously (they return the client/an array/a number, never a promise).
// Mirrors the method set rpc-reflector treats specially (`prop in
// EventEmitter.prototype`).
const SUBSCRIBE_METHODS = new Set(['addListener', 'on', 'once'])
const UNSUBSCRIBE_METHODS = new Set([
  'removeListener',
  'off',
  'removeAllListeners',
])
const OTHER_EMITTER_METHODS = new Set([
  'emit',
  'eventNames',
  'listeners',
  'listenerCount',
])

/**
 * Build the Proxy returned for a reference after the whole client is closed.
 * Method calls (including nested namespaces such as `project.observation.*`)
 * reject with `makeError()`, keeping the `Promise`-returning contract callers
 * expect. EventEmitter methods are the exception: callers don't await them,
 * so a rejected promise would surface as an unhandled rejection. Subscribe
 * methods throw synchronously at the call site; unsubscribe methods are
 * chainable no-ops — removing a listener from a dead client is correct
 * teardown (React effect cleanup runs against stale references).
 *
 * @param {() => Error} makeError
 */
function createClosedProxy(makeError) {
  /** @type {any} */
  let proxy
  /** @type {ProxyHandler<any>} */
  const handler = {
    get(_target, prop) {
      if (typeof prop === 'string') {
        if (SUBSCRIBE_METHODS.has(prop) || OTHER_EMITTER_METHODS.has(prop)) {
          return () => {
            throw makeError()
          }
        }
        if (UNSUBSCRIBE_METHODS.has(prop)) {
          return () => proxy
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
  proxy = new Proxy({}, handler)
  return proxy
}

/**
 * @typedef {Omit<ClientApi<MapeoProject>, 'close'>} ComapeoProjectClientApi
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
 * `createClient.rejectPending` / `createClient.resubscribe` ship in
 * rpc-reflector >= 4.4. Fail with a clear message rather than a bare
 * TypeError when the installed version predates them.
 *
 * @param {'rejectPending' | 'resubscribe'} name
 */
function assertResetApi(name) {
  if (typeof (/** @type {any} */ (createClient)[name]) !== 'function') {
    throw new Error(
      `createClient.${name} is unavailable — transport-reset support requires rpc-reflector >= 4.4`,
    )
  }
}

/**
 * Create the client side of `createComapeoCoreServer`.
 *
 * Project references returned by `getProject` are permanent: each is bound to
 * a channel keyed by the project's public id, which the server keeps valid
 * across instance close/re-open cycles (and across server restarts). There is
 * no client-visible project lifecycle — no `close()`, and no reference ever
 * goes stale. Calls to a project this device has left reject with
 * `ProjectLeftError` (server-side); calls to an unknown project reject with
 * core's `NotFoundError`.
 *
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {ComapeoCoreClientApi}
 */
export function createComapeoCoreClient(messagePort, opts = {}) {
  /**
   * projectPublicId → permanent wrapper. Never evicted: the channel id is
   * stable, so the wrapper stays valid for the lifetime of this client.
   * @type {Map<string, ComapeoProjectClientApi>}
   */
  const projectClients = new Map()

  /**
   * projectPublicId → in-flight `getProject`. Dedupes concurrent calls;
   * entries are removed on settle so later calls re-validate.
   * @type {Map<string, Promise<ComapeoProjectClientApi>>}
   */
  const pendingProjectClients = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every project wrapper,
   * swept by `closeComapeoCoreClient`.
   * @type {Set<{
   *   client: ClientApi<MapeoProject>,
   *   channel: SubChannel,
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

  // Set once `closeComapeoCoreClient` has torn the whole client down. Read by
  // the manager proxy and the per-project wrappers so that calls after close
  // surface `ClientClosedError` instead of rpc-reflector's `ChannelClosed`.
  let clientClosed = false
  const clientClosedProxy = createClosedProxy(() => new ClientClosedError())

  function handleTransportReset() {
    if (clientClosed) return
    assertResetApi('rejectPending')
    // Fail in-flight calls fast with a distinguishable, retryable error
    // instead of leaving them to hit the per-call timeout. Resubscription is
    // deliberately NOT done here: at drop time the transport is down, and
    // each ON frame written into it can nudge the native transport into
    // retrying forever while the server stays down. The consumer calls
    // `resubscribeCoreClient` once the transport is back up. Project
    // references stay valid: their channels are keyed by project id, which
    // a restarted server serves identically.
    createClient.rejectPending(managerClient, new TransportClosedError())
    createClient.rejectPending(projectRoutingClient, new TransportClosedError())
    for (const entry of openProjectClients) {
      createClient.rejectPending(entry.client, new TransportClosedError())
    }
  }

  function handleResubscribe() {
    if (clientClosed) return
    assertResetApi('resubscribe')
    // Safe to call repeatedly: the server ignores duplicate ON messages. A
    // replayed project subscription also re-opens that project server-side —
    // an active listener is an expression of interest.
    createClient.resubscribe(managerClient)
    for (const entry of openProjectClients) {
      createClient.resubscribe(entry.client)
    }
  }

  const client = new Proxy(managerClient, {
    get(target, prop, receiver) {
      if (prop === TRANSPORT_RESET) {
        return handleTransportReset
      }

      if (prop === RESUBSCRIBE) {
        return handleResubscribe
      }

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
          projectClients.clear()

          // Closed last so in-flight `assertProjectExists` calls awaited
          // above can complete rather than reject.
          projectRoutingChannel.close()
          createClient.close(projectRoutingClient)

          clientClosed = true
        }
      }

      if (prop === 'getProject') {
        return getProject
      }

      // `then` must stay falsy so awaiting the client (a thenable check) does
      // not route into the throwing proxy.
      if (clientClosed && prop !== 'then') {
        return Reflect.get(clientClosedProxy, prop)
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
  async function getProject(projectPublicId) {
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
   * @param {string} projectPublicId
   * @returns {Promise<ComapeoProjectClientApi>}
   */
  async function resolveProjectClient(projectPublicId) {
    // One round trip on every `getProject`, so a bad id rejects here (with
    // `NotFoundError` / `ProjectLeftError`) rather than on the first method
    // call, and so the server opens the project eagerly. The returned
    // wrapper is the same object across calls.
    await projectRoutingClient.assertProjectExists(projectPublicId)

    const existing = projectClients.get(projectPublicId)
    if (existing) return existing

    const wrapper = createProjectClientWrapper(projectPublicId)
    projectClients.set(projectPublicId, wrapper)
    return wrapper
  }

  /**
   * @param {string} projectPublicId
   * @returns {ComapeoProjectClientApi}
   */
  function createProjectClientWrapper(projectPublicId) {
    const projectChannel = new SubChannel(
      messagePort,
      `${PROJECT_CHANNEL_PREFIX}${projectPublicId}`,
    )

    /** @type {ClientApi<MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    openProjectClients.add({ client: projectClient, channel: projectChannel })

    const wrappedProjectClient = new Proxy(projectClient, {
      get(target, prop, receiver) {
        // Project lifecycle is server-owned: the reflected surface must not
        // expose `MapeoProject.close`, which would close the server-side
        // instance out from under every other consumer.
        if (prop === 'close') return undefined
        if (clientClosed && prop !== 'then') {
          return Reflect.get(clientClosedProxy, prop)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return /** @type {any} */ (wrappedProjectClient)
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
 * Notify the client that its transport to the server has dropped (e.g. the
 * process hosting the server died): every in-flight call — manager, project
 * routing, and per-project — rejects immediately with `TransportClosedError`
 * instead of waiting out its timeout. The client remains fully usable;
 * project references stay valid and serve the restarted server once the
 * transport reconnects. Safe to call repeatedly; no-op after
 * `closeComapeoCoreClient`.
 *
 * Deliberately does NOT replay event subscriptions — call
 * {@link resubscribeCoreClient} once the transport is connected again.
 *
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 */
export function notifyCoreClientTransportReset(client) {
  // @ts-expect-error
  client[TRANSPORT_RESET]()
}

/**
 * Re-send every event subscription (manager and per-project) to the server.
 * Call after the transport to a restarted server is connected again — the
 * fresh server has no subscription state until then. Safe to call
 * repeatedly (the server ignores duplicate subscriptions); no-op after
 * `closeComapeoCoreClient`.
 *
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 */
export function resubscribeCoreClient(client) {
  // @ts-expect-error
  client[RESUBSCRIBE]()
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
 * Services-client counterpart of {@link notifyCoreClientTransportReset}:
 * reject the services client's in-flight calls with `TransportClosedError`.
 * Safe to call repeatedly and after `closeComapeoServicesClient` (no-op).
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 */
export function notifyServicesClientTransportReset(servicesClient) {
  assertResetApi('rejectPending')
  createClient.rejectPending(servicesClient, new TransportClosedError())
}

/**
 * Services-client counterpart of {@link resubscribeCoreClient}: re-send the
 * services client's event subscriptions once the transport is back up. Safe
 * to call repeatedly and after `closeComapeoServicesClient` (no-op).
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 */
export function resubscribeServicesClient(servicesClient) {
  assertResetApi('resubscribe')
  createClient.resubscribe(servicesClient)
}
