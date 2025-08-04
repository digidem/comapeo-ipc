import { createServer } from 'rpc-reflector/server.js'
import {
  MANAGER_CHANNEL_ID,
  MAPEO_RPC_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { extractMessageEventData } from './lib/utils.js'

/**
 * @param {import('@comapeo/core').MapeoManager} manager
 * @param {import('./lib/sub-channel.js').MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createMapeoServer(manager, messagePort, opts) {
  /** @type {Map<string, { close: () => void }>} */
  const existingProjectServers = new Map()

  /** @type {Map<string, SubChannel>} */
  const existingProjectChannels = new Map()

  const mapeoRpcApi = new MapeoRpcApi(manager)

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const mapeoRpcChannel = new SubChannel(messagePort, MAPEO_RPC_ID)

  const managerServer = createServer(manager, managerChannel, opts)
  const mapeoRpcServer = createServer(mapeoRpcApi, mapeoRpcChannel, opts)

  managerChannel.start()
  mapeoRpcChannel.start()

  messagePort.addEventListener('message', handleMessage)

  return {
    close() {
      messagePort.removeEventListener('message', handleMessage)

      for (const [id, server] of existingProjectServers.entries()) {
        server.close()

        const channel = existingProjectChannels.get(id)

        if (channel) {
          channel.close()
          existingProjectChannels.delete(id)
        }

        existingProjectServers.delete(id)
      }

      managerServer.close()
      managerChannel.close()
      mapeoRpcServer.close()
      mapeoRpcChannel.close()
    },
  }

  /**
   * @param {unknown} payload
   */
  async function handleMessage(payload) {
    const data = extractMessageEventData(payload)

    if (!data || typeof data !== 'object' || !('message' in data)) return

    const id = 'id' in data && typeof data.id === 'string' ? data.id : null

    if (!id || id === MANAGER_CHANNEL_ID || id === MAPEO_RPC_ID) return

    if (existingProjectChannels.has(id)) return

    const projectChannel = new SubChannel(messagePort, id)
    existingProjectChannels.set(id, projectChannel)

    let project
    try {
      project = await manager.getProject(id)
    } catch (_err) {
      // TODO: how to respond to client so that method errors?
      projectChannel.close()
      existingProjectChannels.delete(id)
      existingProjectServers.delete(id)
      return
    }

    const { close } = createServer(project, projectChannel, opts)

    existingProjectServers.set(id, { close })

    projectChannel.emit('message', data.message)

    projectChannel.start()
  }
}

export class MapeoRpcApi {
  #manager

  /**
   * @param {import('@comapeo/core').MapeoManager} manager
   */
  constructor(manager) {
    this.#manager = manager
  }

  /**
   * @param {string} projectId
   * @returns {Promise<boolean>}
   */
  async assertProjectExists(projectId) {
    const project = await this.#manager.getProject(projectId)
    return !!project
  }
}
