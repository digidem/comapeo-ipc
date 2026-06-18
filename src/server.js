import { createServer } from 'rpc-reflector/server.js'
import {
  COMAPEO_PREFIX,
  MANAGER_CHANNEL_ID,
  PROJECT_INSTANCE_PREFIX,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { isRelevantEventData } from './lib/utils.js'
import { ProjectClosedError } from './errors.js'

/**
 * @param {import('@comapeo/core').MapeoManager} manager
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createComapeoCoreServer(manager, messagePort, opts) {
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

  /**
   * projectId → in-flight or resolved promise for the current open instance
   * id. Storing the promise (rather than the resolved string) dedupes
   * concurrent `assertProjectExists` calls for the same project so they all
   * resolve to the same instance id, instead of racing into separate
   * `manager.getProject` calls that mint duplicate SubChannels.
   * @type {Map<string, Promise<string>>}
   */
  const currentInstanceForProject = new Map()

  /**
   * Tombstone of instance ids that have been closed. The id string itself
   * is cheap (~30 bytes); however the *first* stale message that arrives
   * on a tombstoned id materialises a stub SubChannel + rpc-reflector
   * server (in `existingInstanceChannels` / `existingInstanceServers`)
   * that lives until the top-level server close. So a project that's
   * closed but never receives a stale call costs ~30 bytes; one that does
   * costs the size of a SubChannel + stub server. Bounded by the number
   * of distinct closed instance ids that ever receive a stale message.
   * @type {Set<string>}
   */
  const closedInstanceIds = new Set()

  /**
   * Instance ids we've already logged an error for. Reaching the drop branch
   * is a "shouldn't happen" case — a prefixed id we minted but lost track of
   * (foreign traffic is dropped earlier, see `handleMessage`); we log once
   * per id so a repeated stray message can't flood logs while a genuine
   * routing bug stays visible.
   * @type {Set<string>}
   */
  const droppedInstanceIds = new Set()

  let instanceCounter = 0

  const projectRoutingApi = new ProjectRoutingApi({
    getProjectInstance(projectId) {
      const existing = currentInstanceForProject.get(projectId)
      if (existing) return existing

      const promise = openProjectInstance(projectId)
      currentInstanceForProject.set(projectId, promise)
      // If the open fails, evict so a subsequent retry can attempt again
      // instead of getting back the same rejected promise. (The close
      // listener handles eviction on the success path.)
      promise.catch(() => {
        if (currentInstanceForProject.get(projectId) === promise) {
          currentInstanceForProject.delete(projectId)
        }
      })
      return promise
    },
  })

  /**
   * @param {string} projectId
   * @returns {Promise<string>}
   */
  async function openProjectInstance(projectId) {
    // Throws if the project doesn't exist; the rejection propagates back
    // to the client through rpc-reflector's standard error response.
    const project = await manager.getProject(projectId)

    const instanceId = `${PROJECT_INSTANCE_PREFIX}${projectId}:${++instanceCounter}`
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

    return instanceId
  }

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const projectRoutingChannel = new SubChannel(messagePort, PROJECT_ROUTING_ID)

  const managerServer = createServer(manager, managerChannel, opts)
  const projectRoutingServer = createServer(
    projectRoutingApi,
    projectRoutingChannel,
    opts,
  )

  managerChannel.start()
  projectRoutingChannel.start()

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
      droppedInstanceIds.clear()
      managerServer.close()
      managerChannel.close()
      projectRoutingServer.close()
      projectRoutingChannel.close()
    },
  }

  /**
   * @param {{ data: unknown }} payload
   */
  async function handleMessage({ data }) {
    if (!isRelevantEventData(data)) return
    const { id } = data

    // Not one of ours. Every id this library mints carries `COMAPEO_PREFIX`,
    // so an id without it belongs to a foreign sender sharing this port —
    // drop it silently (no warning) so unrelated traffic can't flood logs.
    if (!id.startsWith(COMAPEO_PREFIX)) return

    // Reserved channels and currently-open project instances are routed by
    // their own SubChannel listeners; nothing to do here.
    if (
      id === MANAGER_CHANNEL_ID ||
      id === PROJECT_ROUTING_ID ||
      id === SERVICES_ID
    ) {
      return
    }

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
      stubChannel.dispatchEvent({ data: data.message })
      return
    }

    // Carries our prefix but matches no known channel. With the
    // manager/project-routing/services channels and every open and closed
    // project instance accounted for above, reaching here means we minted
    // this id and lost track of it (or a paired client desynced) — a genuine
    // routing bug, not foreign traffic. Logged once per id (see
    // `droppedInstanceIds`).
    if (!droppedInstanceIds.has(id)) {
      droppedInstanceIds.add(id)
      console.error(
        `comapeo-ipc: dropping message for unrecognised channel id "${id}"`,
      )
    }
  }
}

/**
 * Build a Proxy bound as a stub rpc-reflector handler for a closed project
 * instance: it answers property/`has` checks at any depth and throws
 * `ProjectClosedError` when a method is applied (rpc-reflector catches and
 * serializes it back to the client). The outer target is a plain object so the
 * proxy passes rpc-reflector's `typeof handler === 'object'` invariant; nested
 * accesses return a function-target proxy so `applyNestedMethod` finds
 * `typeof === 'function'` and triggers the apply trap.
 */
function createClosedProjectStub() {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get() {
      return new Proxy(function () {}, handler)
    },
    has() {
      return true
    },
    apply() {
      throw new ProjectClosedError()
    },
  }
  return new Proxy({}, handler)
}

export class ProjectRoutingApi {
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
 * The contract for app-provided services that live outside `@comapeo/core` —
 * the map server today, and the blob and icon servers in the future (once
 * extracted from core). The host app implements this; `@comapeo/core-react`
 * and other consumers reach it through `createComapeoServicesClient`.
 *
 * @typedef {object} ComapeoServicesApi
 * @property {object} mapServer
 * @property {() => Promise<string>} mapServer.getBaseUrl Return the base URL of the map server
 */

/**
 * Serve the app-provided services API (see {@link ComapeoServicesApi}) over
 * the shared message port.
 *
 * @param {ComapeoServicesApi} services
 * @param {import('rpc-reflector').MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createComapeoServicesServer(services, messagePort, opts) {
  const servicesChannel = new SubChannel(messagePort, SERVICES_ID)
  const servicesServer = createServer(services, servicesChannel, opts)
  servicesChannel.start()
  return {
    close() {
      servicesServer.close()
      servicesChannel.close()
    },
  }
}
