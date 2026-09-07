import { createClient } from 'rpc-reflector/client.js'

import {
  MANAGER_CHANNEL_ID,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { ClientClosedError } from './errors.js'

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
 * Build the Proxy returned for a closed client reference. Method calls
 * (including nested namespaces) reject with `makeError()`, keeping the
 * `Promise`-returning contract callers expect. EventEmitter methods are the
 * exception: callers don't await them, so a rejected promise would surface as
 * an unhandled rejection — they throw synchronously instead, at the call site.
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

/**
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {ComapeoCoreClientApi}
 */
export function createComapeoCoreClient(messagePort, opts = {}) {
  /**
   * projectPublicId → wrapper. Cached for the life of the connection and never
   * evicted: a closed project is transparently re-opened server-side on the
   * next call, so the same wrapper (and its subchannel) stays valid across
   * close/re-open cycles.
   * @type {Map<string, ClientApi<MapeoProject>>}
   */
  const currentProjectClients = new Map()

  /**
   * projectPublicId → in-flight `getProject`. Dedupes concurrent calls;
   * entries are removed on settle so later calls re-check the cache.
   * @type {Map<string, Promise<ClientApi<MapeoProject>>>}
   */
  const pendingProjectClients = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every project wrapper ever
   * created. Entries are closed by `closeComapeoCoreClient`.
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
  // the manager proxy so that calls after close surface `ClientClosedError`
  // instead of rpc-reflector's `ChannelClosed`. Per-project wrappers are left
  // to their own (now-closed) subchannels, which reject with
  // `RpcChannelClosedError`.
  let clientClosed = false
  const managerClosedProxy = createClosedProxy(() => new ClientClosedError())

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
   * Return the cached wrapper if present; otherwise ask the server to
   * validate the project (which yields the stable subchannel id) and build +
   * cache a fresh wrapper.
   *
   * @param {string} projectPublicId
   * @returns {Promise<ClientApi<MapeoProject>>}
   */
  async function resolveProjectClient(projectPublicId) {
    const cached = currentProjectClients.get(projectPublicId)
    if (cached) return cached

    const instanceId =
      await projectRoutingClient.assertProjectExists(projectPublicId)

    const wrapper = createProjectClientWrapper(projectPublicId, instanceId)
    currentProjectClients.set(projectPublicId, wrapper)
    return wrapper
  }

  /**
   * Build the raw rpc-reflector client bound to the project's (stable)
   * subchannel and register it for teardown. No `close` interception: a
   * `close()` call simply invokes the project's remote `close`, and the
   * subchannel stays open so a later call transparently re-opens the project
   * server-side.
   *
   * @param {string} projectPublicId
   * @param {string} instanceId
   * @returns {ClientApi<MapeoProject>}
   */
  function createProjectClientWrapper(projectPublicId, instanceId) {
    const projectChannel = new SubChannel(messagePort, instanceId)

    /** @type {ClientApi<MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    openProjectClients.add({ client: projectClient, channel: projectChannel })

    return projectClient
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
