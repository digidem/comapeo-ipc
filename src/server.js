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
  // Per-project subchannels are keyed by an *instance id* — a string that is
  // unique to one open lifetime of one project. Every time a project is
  // opened (or re-opened after close), a new instance id is minted and
  // returned to the client by `assertProjectExists`. The client uses it as
  // the SubChannel identifier for that project's per-project messages.
  //
  // This means stale post-close calls from a client wrapper that captured
  // the old instance id cannot collide with a freshly-opened project: they
  // arrive on a different SubChannel id and route to the closed-instance
  // tombstone branch in `handleMessage` instead of the new project's server.

  /** @type {Map<string, { close: () => void }>} */
  const existingInstanceServers = new Map()

  /** @type {Map<string, SubChannel>} */
  const existingInstanceChannels = new Map()

  /** @type {Map<string, string>} projectId → current open instance id */
  const currentInstanceForProject = new Map()

  /**
   * Tombstone of instance ids that have been closed. A stale per-project
   * message arriving on one of these ids gets a stub rpc-server (built
   * lazily on demand) that throws "Project is closed". Tombstones are
   * never cleared; they're just strings, so the cost per closed instance
   * is trivial and bounded by the number of opens-then-closes in a session.
   * @type {Set<string>}
   */
  const closedInstanceIds = new Set()

  let instanceCounter = 0

  const mapeoRpcApi = new MapeoRpcApi({
    getProjectInstance: async (projectId) => {
      const existing = currentInstanceForProject.get(projectId)
      if (existing) return existing

      // Throws if the project doesn't exist; the rejection propagates back
      // to the client through rpc-reflector's standard error response.
      const project = await manager.getProject(projectId)

      const instanceId = `${projectId}:${++instanceCounter}`
      const projectChannel = new SubChannel(messagePort, instanceId)
      existingInstanceChannels.set(instanceId, projectChannel)

      project.once('close', () => {
        closedInstanceIds.add(instanceId)
        currentInstanceForProject.delete(projectId)
        existingInstanceServers.get(instanceId)?.close()
        existingInstanceServers.delete(instanceId)
        projectChannel.close()
        existingInstanceChannels.delete(instanceId)
      })

      const { close } = createServer(project, projectChannel, opts)
      existingInstanceServers.set(instanceId, { close })

      projectChannel.start()

      currentInstanceForProject.set(projectId, instanceId)
      return instanceId
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

      for (const [id, server] of existingInstanceServers.entries()) {
        server.close()
        const channel = existingInstanceChannels.get(id)
        if (channel) {
          channel.close()
          existingInstanceChannels.delete(id)
        }
        existingInstanceServers.delete(id)
      }

      currentInstanceForProject.clear()
      closedInstanceIds.clear()
      managerServer.close()
      managerChannel.close()
      mapeoRpcServer.close()
      mapeoRpcChannel.close()
    },
  }

  /**
   * Handles per-project messages. Real-instance messages are caught by the
   * SubChannel's own listener (registered in its constructor) and dispatched
   * to the rpc-reflector server — this outer handler only fires for ids
   * that don't have an active SubChannel, where we either install a
   * closed-instance stub or drop the message as unknown.
   *
   * @param {unknown} payload
   */
  function handleMessage(payload) {
    const data = extractMessageEventData(payload)

    if (!data || typeof data !== 'object' || !('message' in data)) return

    const id = 'id' in data && typeof data.id === 'string' ? data.id : null

    if (!id || id === MANAGER_CHANNEL_ID || id === MAPEO_RPC_ID) return

    if (existingInstanceChannels.has(id)) return

    if (closedInstanceIds.has(id)) {
      // Stale message for a closed project instance. Build a stub
      // rpc-server bound to a Proxy that throws "Project is closed" for
      // any apply. The error rides the standard serializeError → RESPONSE
      // path. The stub holds no reference to the (already-released)
      // project. The stub stays alive on `existingInstanceChannels`/
      // `existingInstanceServers` for the rest of the session, so further
      // stale messages on this instance id route through the SubChannel's
      // own listener directly without re-entering this branch.
      const stubChannel = new SubChannel(messagePort, id)
      existingInstanceChannels.set(id, stubChannel)
      const stubHandler = createClosedProjectStub()
      const { close: closeStubServer } = createServer(
        stubHandler,
        stubChannel,
        opts,
      )
      existingInstanceServers.set(id, { close: closeStubServer })
      stubChannel.start()
      stubChannel.emit('message', data.message)
      return
    }

    // Unknown instance id — silently drop. Could happen for a malformed
    // message or a stale message from a prior `comapeo-ipc` session sharing
    // the same messagePort.
  }
}

function createClosedProjectStub() {
  return createThrowingProxy(() => new Error('Project is closed'))
}

/**
 * Build a Proxy that responds truthfully to property/has checks at any depth
 * and throws `makeError()` when applied as a function. The outer target is a
 * plain object so the proxy passes rpc-reflector's `typeof handler ===
 * 'object'` invariant (the outer is intentionally non-callable — only nested
 * function-target proxies returned from `get` are invoked). Nested accesses
 * return a function-target proxy so that `applyNestedMethod` finds
 * `typeof === 'function'` and triggers the apply trap.
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
  #getProjectInstance

  /**
   * @param {{ getProjectInstance: (projectId: string) => Promise<string> }} opts
   */
  constructor({ getProjectInstance }) {
    this.#getProjectInstance = getProjectInstance
  }

  /**
   * Verify the project exists, opening it (or re-opening it after close)
   * if necessary, and return the per-instance subchannel id the client
   * should use for per-project messages. The returned id is unique to the
   * current open lifetime of the project — closing and re-opening yields
   * a different id.
   *
   * @param {string} projectId
   * @returns {Promise<string>} instance id
   */
  async assertProjectExists(projectId) {
    return this.#getProjectInstance(projectId)
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
