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

/** @import { MessagePortLike } from 'rpc-reflector' */
/** @import { MapeoProject, MapeoManager } from '@comapeo/core' */

/**
 * Build the rpc-reflector handler bound to one project's subchannel.
 *
 * Rather than capturing a single `MapeoProject` instance at open time, the
 * handler is a `Proxy` that always dispatches against the *current* live
 * instance held in `state.current`. That instance is re-resolved by calling
 * `manager.getProject(projectId)` on every method request (via
 * `onRequestHook`) and whenever the client (re-)validates the project, so a
 * project that was closed and re-opened is transparently re-opened and every
 * call lands on the live instance. No close listener is needed.
 *
 * The proxy forwards `get`/`has` to the live instance and binds functions to
 * it (so top-level methods keep the correct `this`), and `getPrototypeOf`
 * returns the live instance's prototype so `proxy instanceof EventEmitter`
 * stays true — which is what lets rpc-reflector's event subscription
 * (`getNestedEventEmitter`) resolve to the real emitter and forward project
 * events (including `close`) to the client.
 *
 * @param {MapeoManager} manager
 * @param {string} projectId
 * @returns {{ handler: object, resolve: () => Promise<MapeoProject> }}
 */
function createLiveProjectHandler(manager, projectId) {
  /** @type {{ current: MapeoProject | null, error: Error | null }} */
  const state = { current: null, error: null }

  /**
   * Poisoned proxy installed as `state.current` after a failed `resolve()`.
   * Any property access returns itself (so nested namespaces like
   * `project.observation.create` keep resolving), and any call throws the
   * original error. rpc-reflector's `applyNestedMethod` hits the throw and
   * `handleRequest`'s try/catch serialises it back to the client.
   */
  const errorProxy = new Proxy(function () {}, {
    get() {
      return errorProxy
    },
    has() {
      return true
    },
    apply() {
      throw state.error
    },
  })

  /** @type {ProxyHandler<any>} */
  const handler = {
    get(_target, prop) {
      const current = state.current
      if (current == null) return undefined
      if (current === errorProxy) return errorProxy
      const value = Reflect.get(current, prop)
      return typeof value === 'function' ? value.bind(current) : value
    },
    has(_target, prop) {
      const current = state.current
      if (current == null) return false
      if (current === errorProxy) return true
      return Reflect.has(current, prop)
    },
    getPrototypeOf() {
      const current = state.current
      if (current == null || current === errorProxy) return Object.prototype
      return Object.getPrototypeOf(current)
    },
  }

  /** @type {Promise<MapeoProject> | null} */
  let inflightResolve = null

  /**
   * Re-resolve the live project instance, refreshing `state.current`. Called
   * on every method request and when the client validates the project.
   *
   * Concurrent calls share the same in-flight promise so `state.current` is
   * written once, in completion order. On failure `state.current` is poisoned
   * with `errorProxy` so the dispatch throws the original error.
   * @returns {Promise<MapeoProject>}
   */
  function resolve() {
    inflightResolve ??= (async () => {
      try {
        const project = await manager.getProject(projectId)
        state.current = project
        state.error = null
        return project
      } catch (err) {
        state.error = err
        state.current = errorProxy
        throw err
      } finally {
        inflightResolve = null
      }
    })()
    return inflightResolve
  }

  return { handler: new Proxy({}, handler), resolve }
}

/**
 * @param {MapeoManager} manager
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createServer>[2]} [opts]
 */
export function createComapeoCoreServer(manager, messagePort, opts) {
  // Per-project subchannels are keyed by a *stable* instance id derived
  // purely from the project's public id (no per-open counter). The channel —
  // and the live handler bound to it — outlives individual open/close
  // cycles: the client keeps one wrapper per project for the life of the
  // connection, and the handler re-resolves the live instance on each call.

  /** @type {Map<string, { close: () => void }>} */
  const existingInstanceServers = new Map()

  /** @type {Map<string, SubChannel>} */
  const existingInstanceChannels = new Map()

  /**
   * projectId → in-flight or resolved promise for the instance id. Storing the
   * promise (rather than the resolved string) dedupes concurrent
   * `assertProjectExists` calls for the same project so they all resolve to
   * the same id and the channel/server is created once, not raced into
   * duplicates. Evicted on reject so a failed open can be retried.
   * @type {Map<string, Promise<string>>}
   */
  const currentInstanceForProject = new Map()

  /**
   * Instance ids we've already logged an error for. Reaching the drop branch
   * is a "shouldn't happen" case — a prefixed id we minted but lost track of
   * (foreign traffic is dropped earlier, see `handleMessage`); we log once
   * per id so a repeated stray message can't flood logs while a genuine
   * routing bug stays visible.
   * @type {Set<string>}
   */
  const droppedInstanceIds = new Set()

  const projectRoutingApi = new ProjectRoutingApi({
    getProjectInstance(projectId) {
      const existing = currentInstanceForProject.get(projectId)
      if (existing) return existing

      const promise = openProjectInstance(projectId)
      currentInstanceForProject.set(projectId, promise)
      // If the open fails, evict so a subsequent retry can attempt again
      // instead of getting back the same rejected promise.
      promise.catch(() => {
        if (currentInstanceForProject.get(projectId) === promise) {
          currentInstanceForProject.delete(projectId)
        }
      })
      return promise
    },
  })

  /**
   * Validate the project exists, create its subchannel + live server on first
   * use, and return its stable instance id.
   *
   * @param {string} projectId
   * @returns {Promise<string>} instance id
   */
  async function openProjectInstance(projectId) {
    // Throws if the project doesn't exist; the rejection propagates back
    // to the client through rpc-reflector's standard error response. This
    // also seeds the live handler's `state.current` so project events can be
    // resolved before the first method call arrives.
    const { handler, resolve } = createLiveProjectHandler(manager, projectId)
    await resolve()

    const instanceId = `${PROJECT_INSTANCE_PREFIX}${projectId}`
    if (!existingInstanceChannels.has(instanceId)) {
      const projectChannel = new SubChannel(messagePort, instanceId)

      // Re-resolve the live project on every method request so a
      // closed-then-re-opened project is transparently re-opened and the call
      // dispatches against the current instance.
      const { close } = createServer(handler, projectChannel, {
        ...opts,
        onRequestHook(request, next) {
          ;(async () => {
            try {
              await resolve()
            } catch {
              // state.current is already poisoned with errorProxy
            }
            next(request)
          })()
        },
      })

      existingInstanceChannels.set(instanceId, projectChannel)
      existingInstanceServers.set(instanceId, { close })
      projectChannel.start()
    }

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

    // Carries our prefix but matches no known channel. With the
    // manager/project-routing/services channels and every project instance
    // accounted for above, reaching here means we minted this id and lost
    // track of it (or a paired client desynced) — a genuine routing bug, not
    // foreign traffic. Logged once per id (see `droppedInstanceIds`).
    if (!droppedInstanceIds.has(id)) {
      droppedInstanceIds.add(id)
      console.error(
        `comapeo-ipc: dropping message for unrecognised channel id "${id}"`,
      )
    }
  }
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
   * Verify the project exists, opening it (or re-opening it after close) if
   * necessary, and return the stable per-project subchannel id the client
   * should use for per-project messages. The id is derived from the project's
   * public id and stays the same across close/re-open cycles.
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
