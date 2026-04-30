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
 * @param {import('./lib/sub-channel.js').MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {MapeoClientApi}
 */
export function createMapeoClient(messagePort, opts = {}) {
  /** @type {Map<string, Promise<import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>>>} */
  const projectClientPromises = new Map()

  /**
   * Registry of every per-project rpc-reflector client + SubChannel pair
   * we've created. Parallel to `projectClientPromises`: when a project is
   * individually closed, its cache entry is evicted so a subsequent
   * `getProject(id)` returns a fresh wrapper, but the inner client and
   * channel stay alive so the server's "Project is closed" stub can still
   * answer post-close method calls on the old wrapped reference.
   * `closeMapeoClient` iterates this set for cleanup.
   * @type {Set<{
   *   client: import('rpc-reflector/client.js').ClientApi<import('@comapeo/core').MapeoProject>,
   *   channel: SubChannel,
   * }>}
   */
  const allProjectClients = new Set()

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
          // closing project clients. `allProjectClients` is populated
          // synchronously after `assertProjectExists` resolves, so any
          // creation that hasn't settled yet isn't in the registry.
          await Promise.allSettled(projectClientPromises.values())

          for (const entry of allProjectClients) {
            createClient.close(entry.client)
            entry.channel.close()
          }
          allProjectClients.clear()
          // Note: `projectClientPromises` is intentionally NOT cleared.
          // Existing behaviour (verified by the "Client calls fail after
          // server closes" test) is that `getProject(id)` after manager
          // close returns the cached wrapper rather than retrying — any
          // subsequent method call rejects via the closed channel.
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

    try {
      await mapeoRpcClient.assertProjectExists(projectPublicId)
    } catch (err) {
      // Failed to open the project — drop the cached promise so a
      // subsequent getProject() call can retry instead of getting back
      // the same rejected promise.
      projectClientPromises.delete(projectPublicId)
      deferred.reject(err)
      throw err
    }

    const projectChannel = new SubChannel(messagePort, projectPublicId)

    /** @type {import('rpc-reflector').ClientApi<import('@comapeo/core').MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    allProjectClients.add({ client: projectClient, channel: projectChannel })

    // Wrap projectClient to intercept `close` so the cache entry is evicted
    // once the wire close resolves. After eviction, `getProject(id)` returns
    // a fresh wrapper. The inner client and channel are NOT closed here —
    // they stay alive (until `closeMapeoClient`) so the server's tombstone
    // stub can still answer any post-close method calls posted via this
    // wrapper, surfacing a clean "Project is closed" rejection instead of
    // an rpc-reflector timeout. All other property accesses delegate to
    // the inner client unchanged.
    const wrappedProjectClient = new Proxy(projectClient, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return async () => {
            try {
              await target.close()
            } finally {
              projectClientPromises.delete(projectPublicId)
            }
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
 * @param {import('./lib/sub-channel.js').MessagePortLike} messagePort
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
