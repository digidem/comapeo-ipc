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
 * Phantom brand so an app RPC client can't be confused with a raw rpc-reflector
 * client (e.g. when passed to `closeAppRpcClient`).
 *
 * @template Tag
 * @typedef {{ readonly [K in `__appRpc_${Tag & string}`]: void }} Brand
 */

/**
 * Client-side type for an app RPC api. `T` is the api shape defined by the
 * consuming app (the same object passed to `createAppRpcServer`): each method
 * becomes async and nested namespaces are preserved. Defaults to `unknown` so
 * that an un-annotated client is a type error rather than silently untyped.
 *
 * @template [T=unknown]
 * @typedef {import('rpc-reflector/client.js').ClientApi<T & {}> & Brand<'AppRpcApi'>} AppRpcClientApi
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

          const projectClientResults = await Promise.allSettled(
            projectClientPromises.values(),
          )

          for (const result of projectClientResults) {
            if (result.status === 'fulfilled') {
              createClient.close(result.value)
            }
          }
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

    try {
      await mapeoRpcClient.assertProjectExists(projectPublicId)
    } catch (err) {
      deferred.reject(err)
      throw err
    }

    const projectChannel = new SubChannel(messagePort, projectPublicId)

    /** @type {import('rpc-reflector').ClientApi<import('@comapeo/core').MapeoProject>} */
    const projectClient = createClient(projectChannel, opts)
    projectChannel.start()

    deferred.resolve(projectClient)

    return projectClient
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
 * Create an rpc client for application RPC messages that are not part of core,
 * e.g. the different servers for maps, and in the future for serving blobs and
 * icons (once extracted from core)
 *
 * @template [T=unknown]
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 * @return {AppRpcClientApi<T>}
 */
export function createAppRpcClient(messagePort, opts = {}) {
  const appRpcChannel = new SubChannel(messagePort, APP_RPC_ID)
  const appRpcClient = createClient(appRpcChannel, opts)
  appRpcChannel.start()
  // TS can't know the type of the client, so we cast it in the function return
  return /** @type {AppRpcClientApi<T>} */ (appRpcClient)
}

/**
 * Close the app RPC client (removes listeners but does not close the message port)
 *
 * @param {AppRpcClientApi} appRpcClient client created with `createAppRpcClient`
 */
export function closeAppRpcClient(appRpcClient) {
  createClient.close(appRpcClient)
}
