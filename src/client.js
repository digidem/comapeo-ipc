import { createClient } from 'rpc-reflector/client.js'
import pDefer from 'p-defer'

import {
  APP_RPC_ID,
  MANAGER_CHANNEL_ID,
  MAPEO_RPC_ID,
  SubChannel,
} from './lib/sub-channel.js'

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>} MapeoProjectApi
 */

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<
 *   Omit<
 *     import('@comapeo/core').MapeoManager,
 *     'getProject'
 *   > & {
 *     getProject: (projectPublicId: string) => Promise<MapeoProjectApi>
 *   }
 * >} MapeoClientApi */

const CLOSE = Symbol('close')

/**
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {MapeoClientApi}
 */
export function createMapeoClient(messagePort, opts = {}) {
  /** @type {Map<string, Promise<import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>>>} */
  const projectClientPromises = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every currently-open
   * project. Entries are removed when the project's wrapped `close()`
   * settles; `closeMapeoClient` sweeps whatever is left.
   * @type {Set<{
   *   client: import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>,
   *   channel: SubChannel,
   * }>}
   */
  const openProjectClients = new Set()

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const mapeoRpcChannel = new SubChannel(messagePort, MAPEO_RPC_ID)

  /** @type {import('rpc-reflector').ClientApi<import('@comapeo/core').MapeoManager>} */
  const managerClient = createClient(managerChannel, opts)
  /** @type {import('rpc-reflector').ClientApi<import('./server.js').MapeoRpcApi>} */
  const mapeoRpcClient = createClient(mapeoRpcChannel, opts)

  mapeoRpcChannel.start()
  managerChannel.start()

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
          // method calls reject with "Channel closed".

          // Closed last so in-flight `assertProjectExists` calls awaited
          // above can complete rather than reject.
          mapeoRpcChannel.close()
          createClient.close(mapeoRpcClient)
        }
      }

      if (prop === 'getProject') {
        return createProjectClient
      }

      return Reflect.get(target, prop, receiver)
    },
  })

  // TS can't know the type of the proxy, so we cast it in the function return
  return /** @type {any} */ (client)

  /**
   * @param {string} projectPublicId
   * @returns {Promise<MapeoProjectApi>}
   */
  async function createProjectClient(projectPublicId) {
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
      instanceId = await mapeoRpcClient.assertProjectExists(projectPublicId)
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
    // Further method calls on this wrapper reject with "Channel closed".
    // The close promise is cached so repeated `close()` calls return the
    // same result instead of failing on the already-closed channel. All
    // other property accesses delegate to the inner client unchanged.
    /** @type {Promise<void> | null} */
    let closePromise = null
    const wrappedProjectClient = new Proxy(projectClient, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return () => {
            closePromise ??= (async () => {
              try {
                await target.close()
              } finally {
                projectClientPromises.delete(projectPublicId)
                openProjectClients.delete(registryEntry)
                createClient.close(projectClient)
                projectChannel.close()
              }
            })()
            return closePromise
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    deferred.resolve(wrappedProjectClient)
    return wrappedProjectClient
  }
}

/**
 * @param {MapeoClientApi} client client created with `createMapeoClient`
 * @returns {Promise<void>}
 */
export async function closeMapeoClient(client) {
  // @ts-expect-error
  return client[CLOSE]()
}

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<import('./server.js').RpcApi>} AppRpcApi
 */

/**
 * Create an rpc client for application RPC messages that are not part of core,
 * e.g. the different servers for maps, and in the future for serving blobs and
 * icons (once extracted from core)
 *
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 * @return {AppRpcApi}
 */
export function createAppRpcClient(messagePort, opts = {}) {
  const appRpcChannel = new SubChannel(messagePort, APP_RPC_ID)
  const appRpcClient = /** @type {AppRpcApi} */ (
    createClient(appRpcChannel, opts)
  )
  appRpcChannel.start()
  return appRpcClient
}

/**
 * Close the app RPC client (removes listeners but does not close the message port)
 *
 * @param {AppRpcApi} appRpcClient client created with `createAppRpcClient`
 */
export function closeAppRpcClient(appRpcClient) {
  createClient.close(appRpcClient)
}
