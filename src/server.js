import { createServer } from 'rpc-reflector/server.js'
import {
  COMAPEO_PREFIX,
  MANAGER_CHANNEL_ID,
  PROJECT_CHANNEL_PREFIX,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { isRelevantEventData } from './lib/utils.js'
import { ProjectLeftError } from './errors.js'

/** @import { MessagePortLike } from 'rpc-reflector' */
/** @import { MapeoManager, MapeoProject } from '@comapeo/core' */

function noop() {}

/**
 * Serve a `MapeoManager` (and its projects) over the shared message port.
 *
 * Project instance lifecycle is fully owned by this server: each project has
 * one channel, keyed by its public id, that is stable across close/re-open
 * cycles. Behind that channel sits a single long-lived rpc-reflector server
 * created with a handler *factory* (see {@link createProjectHost}):
 * rpc-reflector binds a live `MapeoProject` instance lazily, keeps client
 * subscriptions across instance changes, and re-attaches them to each fresh
 * instance before serving any call against it. Clients never see instance
 * identity and cannot close projects.
 *
 * The one thing the server will not transparently re-open is a project this
 * device has left: calls to a left project reject with `ProjectLeftError`
 * until the project is re-joined (`addProject` on re-invite). A `leaveProject`
 * call routed through this server also closes the gutted instance that core
 * leaves cached (core only cleans that up itself inside `addProject`).
 *
 * @param {MapeoManager} manager
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createComapeoCoreServer(manager, messagePort, opts) {
  /** @type {Map<string, ProjectHost>} */
  const projectHosts = new Map()

  /**
   * Channel ids we've already logged an error for. Reaching the drop branch
   * is a "shouldn't happen" case — a prefixed id that matches no reserved
   * channel and no project route; we log once per id so a repeated stray
   * message can't flood logs while a genuine routing bug stays visible.
   * @type {Set<string>}
   */
  const droppedChannelIds = new Set()

  /**
   * @param {string} projectPublicId
   * @returns {ProjectHost}
   */
  function getOrCreateHost(projectPublicId) {
    let host = projectHosts.get(projectPublicId)
    if (!host) {
      host = createProjectHost({ manager, messagePort, projectPublicId, opts })
      projectHosts.set(projectPublicId, host)
    }
    return host
  }

  /**
   * Close the stale instance core leaves cached after `leaveProject` (core
   * opens the project to leave it, guts it, and keeps it in its cache; only
   * `addProject` on re-invite cleans it up). The instance's `close` event
   * also detaches the project host's handler, so the next call hits the
   * left-project guard instead of the gutted instance.
   *
   * Interim, paired with the left-project guard in {@link createProjectHost}:
   * both go away together once core ships a typed PROJECT_LEFT error
   * (digidem/comapeo-core#1313).
   *
   * @param {string} projectPublicId
   */
  async function closeLeftProjectInstance(projectPublicId) {
    try {
      const project = await manager.getProject(projectPublicId)
      await project.close()
    } catch {
      // Never opened, or already gone — nothing to close.
    }
  }

  /**
   * Wrap the consumer's request hook (if any) so `leaveProject` completions
   * trigger the stale-instance cleanup above, without touching the manager
   * object itself (binding or proxying the manager breaks its private-field
   * methods).
   *
   * @type {NonNullable<Parameters<typeof createServer>[2]>['onRequestHook']}
   */
  const managerRequestHook = (request, next) => {
    /** @type {typeof next} */
    const instrumentedNext = (req) => {
      const result = next(req)
      if (req.method.length === 1 && req.method[0] === 'leaveProject') {
        const projectPublicId = req.args[0]
        if (typeof projectPublicId === 'string') {
          Promise.resolve(result).then(
            () => closeLeftProjectInstance(projectPublicId),
            // Leave can fail after opening (and possibly gutting) the
            // instance; closing is safe either way — a healthy project
            // re-opens on the next call.
            () => closeLeftProjectInstance(projectPublicId),
          )
        }
      }
      return result
    }
    const consumerHook = opts?.onRequestHook
    if (consumerHook) {
      consumerHook(request, instrumentedNext)
    } else {
      instrumentedNext(request)
    }
  }

  const projectRoutingApi = new ProjectRoutingApi({
    ensureProject: (projectPublicId) =>
      getOrCreateHost(projectPublicId).ensureHandler(),
  })

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const projectRoutingChannel = new SubChannel(messagePort, PROJECT_ROUTING_ID)

  const managerServer = createServer(manager, managerChannel, {
    ...opts,
    onRequestHook: managerRequestHook,
  })
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

      for (const host of projectHosts.values()) {
        host.close()
      }
      projectHosts.clear()
      droppedChannelIds.clear()

      managerServer.close()
      managerChannel.close()
      projectRoutingServer.close()
      projectRoutingChannel.close()
    },
  }

  /**
   * @param {{ data: unknown }} payload
   */
  function handleMessage({ data }) {
    if (!isRelevantEventData(data)) return
    const { id } = data

    // Not one of ours. Every id this library mints carries `COMAPEO_PREFIX`,
    // so an id without it belongs to a foreign sender sharing this port —
    // drop it silently (no warning) so unrelated traffic can't flood logs.
    if (!id.startsWith(COMAPEO_PREFIX)) return

    // Reserved channels are routed by their own SubChannel listeners.
    if (
      id === MANAGER_CHANNEL_ID ||
      id === PROJECT_ROUTING_ID ||
      id === SERVICES_ID
    ) {
      return
    }

    if (id.startsWith(PROJECT_CHANNEL_PREFIX)) {
      const projectPublicId = id.slice(PROJECT_CHANNEL_PREFIX.length)
      if (projectPublicId.length > 0) {
        if (projectHosts.has(projectPublicId)) return
        // First traffic for this project: the host's channel listener was
        // not yet registered when this event was dispatched at the port
        // level, so hand the frame to the channel directly.
        const host = getOrCreateHost(projectPublicId)
        host.channel.dispatchEvent({ data: data.message })
        return
      }
    }

    // Carries our prefix but matches no known channel shape — we lost track
    // of an id we minted, or a paired client desynced. Logged once per id.
    if (!droppedChannelIds.has(id)) {
      droppedChannelIds.add(id)
      console.error(
        `comapeo-ipc: dropping message for unrecognised channel id "${id}"`,
      )
    }
  }
}

/**
 * @typedef {object} ProjectHost
 * @property {SubChannel} channel
 * @property {() => Promise<void>} ensureHandler
 * @property {() => void} close
 */

/**
 * One per project public id, for the lifetime of the top-level server. Owns
 * the project's stable SubChannel and one long-lived rpc-reflector server
 * bound to it via a late-bound handler factory. rpc-reflector owns the
 * instance lifecycle mechanics: it invokes the factory (single-flight) when
 * the first call or subscription needing a handler arrives, keeps the
 * client's event subscriptions in a registry that survives the instance, and
 * re-attaches them to each fresh instance before any awaited frame is
 * dispatched — so client listeners survive server-side close/re-open cycles
 * they never hear about. A factory rejection (`NotFoundError`,
 * `ProjectLeftError`) is answered per request with the error, and is not
 * cached, so a later call retries.
 *
 * This host adds only what is comapeo-specific: the left-project guard, the
 * close-in-flight retry around `manager.getProject`, and detaching the
 * handler when the instance closes so the next call re-opens.
 *
 * @param {object} options
 * @param {MapeoManager} options.manager
 * @param {MessagePortLike} options.messagePort
 * @param {string} options.projectPublicId
 * @param {Parameters<typeof createServer>[2]} [options.opts]
 * @returns {ProjectHost}
 */
function createProjectHost({ manager, messagePort, projectPublicId, opts }) {
  const channel = new SubChannel(
    messagePort,
    `${PROJECT_CHANNEL_PREFIX}${projectPublicId}`,
  )

  /**
   * Interim left-project guard, paired with the `leaveProject` request hook
   * in `createComapeoCoreServer`; both are removed together once core ships
   * a typed PROJECT_LEFT error (digidem/comapeo-core#1313). Left projects
   * re-open as live-but-gutted instances (core deliberately allows this so
   * an interrupted leave can finish), so leftness must be checked via
   * `listProjects`, not inferred from `getProject`.
   */
  async function assertNotLeft() {
    const projects = await manager.listProjects({ includeLeft: true })
    const entry = projects.find((p) => p.projectId === projectPublicId)
    if (entry && entry.status === 'left') {
      throw new ProjectLeftError()
    }
  }

  /** @returns {Promise<MapeoProject>} */
  async function openProject() {
    await assertNotLeft()
    const project = await getOpenableProject()
    // Re-checked after the open resolves: a leave can land while the open
    // was in flight (leave waits for sync), and binding then would serve
    // calls from the gutted instance instead of rejecting them.
    await assertNotLeft()
    // `once`, not `on`: core's MapeoProject emits `close` twice (once from
    // `_close`, once from ready-resource).
    project.once('close', () => server.detachHandler())
    return project
  }

  /**
   * `manager.getProject` returns the dying instance for the whole duration
   * of an in-flight close (its cache evicts only on the `close` event), so
   * wait out a close-in-progress and retry rather than binding to a corpse.
   *
   * @returns {Promise<MapeoProject>}
   */
  async function getOpenableProject() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const project = await manager.getProject(projectPublicId)
      if (project.closed) continue
      if (project.closing) {
        await Promise.resolve(project.closing).catch(noop)
        continue
      }
      return project
    }
    throw new Error(`Project ${projectPublicId} kept closing while opening`)
  }

  // Created before `start()`, so the first frame — which the top-level
  // router hands to the channel directly — reaches the rpc server.
  const server = createServer(openProject, channel, opts)
  channel.start()

  return {
    channel,
    /**
     * Bind a live instance now (opening it if necessary), so an eager open
     * attaches subscriptions before any project-channel frame. Rejects with
     * `ProjectLeftError` for left projects or whatever `manager.getProject`
     * throws (e.g. `NotFoundError`). Safe to call concurrently.
     */
    ensureHandler: () => server.ensureHandler(),
    close() {
      server.close()
      channel.close()
    },
  }
}

export class ProjectRoutingApi {
  #ensureProject

  /**
   * @param {{ ensureProject: (projectPublicId: string) => Promise<void> }} opts
   */
  constructor({ ensureProject }) {
    this.#ensureProject = ensureProject
  }

  /**
   * Verify the project exists and is usable, opening it (or re-opening it
   * after a server-side close) if necessary. Rejects with `NotFoundError`
   * for unknown projects and `ProjectLeftError` for projects this device has
   * left.
   *
   * @param {string} projectPublicId
   * @returns {Promise<true>}
   */
  async assertProjectExists(projectPublicId) {
    await this.#ensureProject(projectPublicId)
    return true
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
 * @param {MessagePortLike} messagePort
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
