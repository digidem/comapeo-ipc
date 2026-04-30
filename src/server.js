import { createServer } from 'rpc-reflector/server.js'
import {
  APP_RPC_ID,
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

  /**
   * Tombstone of project IDs that have been closed. Subsequent messages for
   * these IDs are routed through a stub handler that throws "Project is
   * closed" rather than silently re-opening the project. Cleared when the
   * client calls `getProject(id)` again (which goes through
   * `assertProjectExists`).
   * @type {Set<string>}
   */
  const closedProjectIds = new Set()

  const mapeoRpcApi = new MapeoRpcApi(manager, {
    onAssertProjectExists: (id) => {
      if (!closedProjectIds.has(id)) return
      closedProjectIds.delete(id)
      const existingChannel = existingProjectChannels.get(id)
      const existingServer = existingProjectServers.get(id)
      if (existingServer) existingServer.close()
      if (existingChannel) existingChannel.close()
      existingProjectChannels.delete(id)
      existingProjectServers.delete(id)
    },
  })

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

      closedProjectIds.clear()
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

    // Tombstone branch: project was closed; build a stub rpc-server that
    // throws "Project is closed" for any method call. Lazy — only allocated
    // on the first stale message for this id. The error rides the standard
    // serializeError → RESPONSE path.
    if (closedProjectIds.has(id)) {
      const stubChannel = new SubChannel(messagePort, id)
      existingProjectChannels.set(id, stubChannel)
      const stubHandler = createClosedProjectStub()
      const { close: closeStubServer } = createServer(
        stubHandler,
        stubChannel,
        opts,
      )
      existingProjectServers.set(id, { close: closeStubServer })
      stubChannel.emit('message', data.message)
      stubChannel.start()
      return
    }

    const projectChannel = new SubChannel(messagePort, id)
    existingProjectChannels.set(id, projectChannel)

    let project
    try {
      project = await manager.getProject(id)
    } catch (err) {
      // Replace with a stub server that returns the actual error to the
      // client, so the awaiting RPC call rejects with the real reason
      // (e.g. NotFoundError) instead of timing out.
      const errorStubHandler = createErrorStub(err)
      const { close: closeErrorStubServer } = createServer(
        errorStubHandler,
        projectChannel,
        opts,
      )
      existingProjectServers.set(id, { close: closeErrorStubServer })
      projectChannel.emit('message', data.message)
      projectChannel.start()
      // Tear down on next tick so the error response is sent first.
      queueMicrotask(() => {
        closeErrorStubServer()
        projectChannel.close()
        existingProjectChannels.delete(id)
        existingProjectServers.delete(id)
      })
      return
    }

    project.once('close', () => {
      closedProjectIds.add(id)
      projectChannel.close()
      existingProjectChannels.delete(id)
      // Close the RPC server when the project is closed
      close()
      existingProjectServers.delete(id)
    })

    const { close } = createServer(project, projectChannel, opts)

    existingProjectServers.set(id, { close })

    projectChannel.emit('message', data.message)

    projectChannel.start()
  }
}

function createClosedProjectStub() {
  return createThrowingProxy(() => new Error('Project is closed'))
}

/**
 * @param {unknown} err
 */
function createErrorStub(err) {
  return createThrowingProxy(() =>
    err instanceof Error ? err : new Error(String(err)),
  )
}

/**
 * Build a Proxy that responds truthfully to property/has checks at any depth
 * and throws `makeError()` when applied as a function. The outer target is a
 * plain object so the proxy passes rpc-reflector's `typeof handler ===
 * 'object'` invariant; nested accesses return a function-target proxy so that
 * `applyNestedMethod` finds `typeof === 'function'` and triggers the apply
 * trap.
 *
 * @param {() => Error} makeError
 */
function createThrowingProxy(makeError) {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get() {
      return new Proxy(function () {}, handler)
    },
    has() {
      return true
    },
    apply() {
      throw makeError()
    },
  }
  return new Proxy({}, handler)
}

export class MapeoRpcApi {
  #manager
  #onAssertProjectExists

  /**
   * @param {import('@comapeo/core').MapeoManager} manager
   * @param {{ onAssertProjectExists?: (projectId: string) => void }} [opts]
   */
  constructor(manager, { onAssertProjectExists } = {}) {
    this.#manager = manager
    this.#onAssertProjectExists = onAssertProjectExists
  }

  /**
   * @param {string} projectId
   * @returns {Promise<boolean>}
   */
  async assertProjectExists(projectId) {
    const project = await this.#manager.getProject(projectId)
    // Re-open hook: clear tombstone / stub for this id so the next
    // per-project message creates a fresh SubChannel + rpc-server bound to
    // the new project instance.
    this.#onAssertProjectExists?.(projectId)
    return !!project
  }
}

/**
 * @typedef {object} RpcApi
 * @property {object} mapServer
 * @property {(options?: { localPort?: number, remotePort?: number }) => Promise<{ localPort: number, remotePort: number }>} mapServer.listen
 * @property {() => Promise<void>} mapServer.close
 */

/**
 * RPC messages that are not part of core, e.g. the different servers for maps,
 * and in the future for serving blobs and icons (once extracted from core)
 * @param {RpcApi} rpc
 * @param {import('./lib/sub-channel.js').MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createAppRpcServer(rpc, messagePort, opts) {
  const appRpcChannel = new SubChannel(messagePort, APP_RPC_ID)
  const appRpcServer = createServer(rpc, appRpcChannel, opts)
  appRpcChannel.start()
  return {
    close() {
      appRpcServer.close()
      appRpcChannel.close()
    },
  }
}
