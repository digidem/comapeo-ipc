import { createClient } from 'rpc-reflector'
import pDefer from 'p-defer'

import {
  MANAGER_CHANNEL_ID,
  MAPEO_RPC_ID,
  SubChannel,
} from './lib/sub-channel.js'

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<import('@mapeo/core/dist/mapeo-project.js').MapeoProject>} MapeoProjectClientApi
 */

/**
 * @typedef {import('rpc-reflector/client.js').ClientApi<
 *   Omit<
 *     import('@mapeo/core').MapeoManager,
 *     'getProject'
 *   > & {
 *     getProject: (projectPublicId: string) => Promise<MapeoProjectClientApi>
 *   }
 * >} MapeoClientApi */

const CLOSE = Symbol('close')

/**
 * @param {import('./lib/sub-channel.js').MessagePortLike} messagePort
 * @returns {MapeoClientApi}
 */
export function createMapeoClient(messagePort) {
  /** @type {Map<string, Promise<import('rpc-reflector/client.js').ClientApi<import('@mapeo/core/dist/mapeo-project.js').MapeoProject>>>} */
  const projectClientPromises = new Map()

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const mapeoRpcChannel = new SubChannel(messagePort, MAPEO_RPC_ID)

  /** @type {import('rpc-reflector').ClientApi<import('@mapeo/core').MapeoManager>} */
  const managerClient = createClient(managerChannel)
  /** @type {import('rpc-reflector').ClientApi<import('./server.js').MapeoRpcApi>} */
  const mapeoRpcClient = createClient(mapeoRpcChannel)

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
   * @returns {Promise<MapeoProjectClientApi>}
   */
  async function createProjectClient(projectPublicId) {
    const existingClientPromise = projectClientPromises.get(projectPublicId)

    if (existingClientPromise) return existingClientPromise

    /** @type {import('p-defer').DeferredPromise<import('rpc-reflector/client.js').ClientApi<import('@mapeo/core/dist/mapeo-project.js').MapeoProject>>}*/
    const deferred = pDefer()

    projectClientPromises.set(projectPublicId, deferred.promise)

    try {
      await mapeoRpcClient.assertProjectExists(projectPublicId)
    } catch (err) {
      deferred.reject(err)
      throw err
    }

    const projectChannel = new SubChannel(messagePort, projectPublicId)

    /** @type {import('rpc-reflector').ClientApi<import('@mapeo/core/dist/mapeo-project.js').MapeoProject>} */
    const projectClient = createClient(projectChannel)
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
