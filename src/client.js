import { createClient } from 'rpc-reflector/client.js'
import pDefer from 'p-defer'

import {
  MANAGER_CHANNEL_ID,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { ClientClosedError, ProjectClosedError } from './errors.js'

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
 * @typedef {import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>} ComapeoProjectClientApi
 */

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<
 *   Omit<
 *     import('@comapeo/core').MapeoManager,
 *     'getProject'
 *   > & {
 *     getProject: (projectPublicId: string) => Promise<ComapeoProjectClientApi>
 *   }
 * >} ComapeoCoreClientApi */

const CLOSE = Symbol('close')

/**
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {ComapeoCoreClientApi}
 */
export function createComapeoCoreClient(messagePort, opts = {}) {
  /** @type {Map<string, Promise<import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>>>} */
  const projectClientPromises = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every currently-open
   * project. Entries are removed when the project's wrapped `close()`
   * settles; `closeComapeoCoreClient` sweeps whatever is left.
   * @type {Set<{
   *   client: import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>,
   *   channel: SubChannel,
   * }>}
   */
  const openProjectClients = new Set()

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const projectRoutingChannel = new SubChannel(messagePort, PROJECT_ROUTING_ID)

  /** @type {import('rpc-reflector').ClientApi<import('@comapeo/core').MapeoManager>} */
  const managerClient = createClient(managerChannel, opts)
  /** @type {import('rpc-reflector').ClientApi<import('./server.js').ProjectRoutingApi>} */
  const projectRoutingClient = createClient(projectRoutingChannel, opts)

  projectRoutingChannel.start()
  managerChannel.start()

  // Set once `closeComapeoCoreClient` has torn the whole client down. Read by the
  // manager proxy and the per-project wrappers so that calls after close
  // surface `ManagerClosedError` instead of rpc-reflector's `ChannelClosed`.
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
          await Promise.allSettled(projectClientPromises.values())

          for (const entry of openProjectClients) {
            createClient.close(entry.client)
            entry.channel.close()
          }
          openProjectClients.clear()
          // `projectClientPromises` is intentionally NOT cleared: a
          // `getProject(id)` after close returns the cached wrapper, whose
          // method calls reject with `ManagerClosedError`.

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

    const existingClientPromise = projectClientPromises.get(projectPublicId)

    if (existingClientPromise) return existingClientPromise

    /** @type {import('p-defer').DeferredPromise<import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>>} */
    const deferred = pDefer()

    projectClientPromises.set(projectPublicId, deferred.promise)

    // Attach a no-op handler so that if the deferred rejects below before
    // any other caller has awaited it, we don't get an unhandled rejection.
    // (Removing the cache entry on failure means concurrent callers may
    // never see deferred.promise.)
    deferred.promise.catch(() => {})

    /** @type {string} */
    let instanceId
    try {
      instanceId =
        await projectRoutingClient.assertProjectExists(projectPublicId)
    } catch (err) {
      // Failed to open the project — drop the cached promise so a
      // subsequent getProject() call can retry instead of getting back
      // the same rejected promise.
      projectClientPromises.delete(projectPublicId)
      deferred.reject(err)
      throw err
    }

    // Per-project messages are scoped to the current open instance, not the
    // project's public id. If this project is closed and re-opened later,
    // `assertProjectExists` returns a different instance id, so the new
    // wrapper uses a fresh SubChannel that can't collide with the old one.
    const projectChannel = new SubChannel(messagePort, instanceId)

    /** @type {import('rpc-reflector').ClientApi<import('@comapeo/core').MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    const registryEntry = { client: projectClient, channel: projectChannel }
    openProjectClients.add(registryEntry)

    // Wrap projectClient to intercept `close`: after the wire close settles,
    // tear down the local client + channel — rejecting any in-flight calls —
    // and evict the cache entry so a subsequent `getProject(id)` re-opens.
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
    const wrappedProjectClient = new Proxy(projectClient, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return () => {
            closePromise ??= (async () => {
              try {
                await target.close()
              } finally {
                closed = true
                projectClientPromises.delete(projectPublicId)
                openProjectClients.delete(registryEntry)
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
    deferred.resolve(wrappedProjectClient)
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
 * @typedef {import('rpc-reflector/client.js').ClientApi<import('./server.js').ComapeoServicesApi>} ComapeoServicesClientApi
 */

/**
 * Create a client for the app-provided services that live outside
 * `@comapeo/core` — the map server today, and the blob and icon servers in the
 * future (once extracted from core). The host app implements the server side;
 * see {@link import('./server.js').ComapeoServicesApi}.
 *
 * @param {import('rpc-reflector').MessagePortLike} messagePort
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
