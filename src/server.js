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

// rpc-reflector wire-frame type tags (`lib/constants.js` in rpc-reflector,
// not on its exports map). The frame format is stable across rpc-reflector
// 4.x; a mismatch here fails loudly in tests, not silently in production.
const MSG_REQUEST = 0
const MSG_ON = 2
const MSG_OFF = 3

function noop() {}

/**
 * Unwrap an rpc-reflector wire frame: messages are either the raw frame array
 * or a `{ value, metadata }` container (used when a request hook attaches
 * metadata). Returns the frame array, or undefined for anything else.
 *
 * @param {unknown} message
 * @returns {unknown[] | undefined}
 */
function unwrapFrame(message) {
  if (Array.isArray(message)) return message
  if (typeof message === 'object' && message !== null && 'value' in message) {
    const { value } = /** @type {{ value: unknown }} */ (message)
    if (Array.isArray(value)) return value
  }
  return undefined
}

/**
 * Serve a `MapeoManager` (and its projects) over the shared message port.
 *
 * Project instance lifecycle is fully owned by this server: each project has
 * one channel, keyed by its public id, that is stable across close/re-open
 * cycles. When a message arrives for a project with no live instance the
 * server re-opens it on demand (via `manager.getProject`), re-binds an
 * rpc-reflector server on the same channel, and replays the project's
 * recorded event subscriptions so client listeners keep working. Clients
 * never see instance identity and cannot close projects.
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
      host = new ProjectHost({ manager, messagePort, projectPublicId, opts })
      projectHosts.set(projectPublicId, host)
    }
    return host
  }

  /**
   * Close the stale instance core leaves cached after `leaveProject` (core
   * opens the project to leave it, guts it, and keeps it in its cache; only
   * `addProject` on re-invite cleans it up). Also returns the project's host
   * to dormant via the instance's `close` event, so the next call hits the
   * left-project guard instead of the gutted instance.
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
    ensureProject: (projectPublicId) => getOrCreateHost(projectPublicId).open(),
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
 * One per project public id, for the lifetime of the top-level server. Owns
 * the project's stable SubChannel and the open/close dance behind it:
 *
 * - **dormant** — no live instance. Incoming calls/subscriptions are
 *   buffered and trigger an open.
 * - **opening** — `manager.getProject` in flight (behind the left-project
 *   guard). New messages keep buffering.
 * - **open** — an rpc-reflector server for the current instance is bound to
 *   the channel; the host only records subscription state.
 *
 * Subscription tape: the host snoops ON/OFF frames on the channel and keeps
 * the set of currently-subscribed events. rpc-reflector server-side
 * subscriptions die with each per-instance server, so on every re-open the
 * tape is replayed into the fresh server before buffered calls are
 * dispatched — client listeners survive server-side closes without knowing
 * they happened.
 */
class ProjectHost {
  /** @type {'dormant' | 'opening' | 'open'} */
  #state = 'dormant'
  /** @type {Promise<void> | null} */
  #openPromise = null
  /** @type {{ close: () => void } | null} */
  #server = null
  /** @type {MapeoProject | null} */
  #project = null
  /** @type {unknown[]} buffered raw messages (frames or containers) */
  #buffer = []
  /**
   * encoded key → ON frame args. Insertion order is replay order.
   * @type {Map<string, { eventName: string, propArray: string[] }>}
   */
  #tape = new Map()
  /** True while this host is re-dispatching frames it already buffered. */
  #replaying = false
  #closed = false

  #manager
  #projectPublicId
  #opts
  /** @type {SubChannel} */
  channel

  /**
   * @param {object} options
   * @param {MapeoManager} options.manager
   * @param {MessagePortLike} options.messagePort
   * @param {string} options.projectPublicId
   * @param {Parameters<typeof createServer>[2]} [options.opts]
   */
  constructor({ manager, messagePort, projectPublicId, opts }) {
    this.#manager = manager
    this.#projectPublicId = projectPublicId
    this.#opts = opts
    this.channel = new SubChannel(
      messagePort,
      `${PROJECT_CHANNEL_PREFIX}${projectPublicId}`,
    )
    this.channel.addEventListener('message', this.#onChannelMessage)
    this.channel.start()
  }

  /** @param {{ data: unknown }} event */
  #onChannelMessage = ({ data }) => {
    if (this.#closed) return
    const frame = unwrapFrame(data)

    // Record subscription state regardless of open/dormant — the tape must
    // reflect the client's current listeners at all times.
    if (frame) {
      const [type, eventName, propArray] = frame
      if (
        (type === MSG_ON || type === MSG_OFF) &&
        typeof eventName === 'string' &&
        Array.isArray(propArray)
      ) {
        const key = JSON.stringify([propArray, eventName])
        if (type === MSG_ON) this.#tape.set(key, { eventName, propArray })
        else this.#tape.delete(key)
      }
    }

    if (this.#replaying) return

    switch (this.#state) {
      case 'open':
        // The bound rpc server has its own listener on this channel.
        return
      case 'opening':
        this.#buffer.push(data)
        return
      case 'dormant': {
        // An unsubscribe alone is not a reason to open a project.
        if (frame && frame[0] === MSG_OFF) return
        this.#buffer.push(data)
        this.open().catch(noop)
        return
      }
    }
  }

  /**
   * Ensure a live instance is bound to this project's channel, opening it if
   * necessary. Resolves once calls can be served; rejects with
   * `ProjectLeftError` for left projects or whatever `manager.getProject`
   * throws (e.g. `NotFoundError`). Safe to call concurrently.
   *
   * @returns {Promise<void>}
   */
  open() {
    if (this.#state === 'open') return Promise.resolve()
    if (this.#openPromise) return this.#openPromise

    const openPromise = this.#doOpen().finally(() => {
      if (this.#openPromise === openPromise) this.#openPromise = null
    })
    this.#openPromise = openPromise
    // Message-triggered opens have no awaiter; keep a rejection from
    // surfacing as an unhandled rejection without detaching other awaiters.
    openPromise.catch(noop)
    return openPromise
  }

  /** @returns {Promise<void>} */
  async #doOpen() {
    this.#state = 'opening'
    try {
      // Left-project guard. Left projects re-open as live-but-gutted
      // instances (core deliberately allows this so an interrupted leave can
      // finish), so leftness must be checked before `getProject`, not
      // inferred from it.
      const projects = await this.#manager.listProjects({ includeLeft: true })
      const entry = projects.find((p) => p.projectId === this.#projectPublicId)
      if (entry && entry.status === 'left') {
        throw new ProjectLeftError()
      }

      const project = await this.#getOpenableProject()
      if (this.#closed) {
        throw new Error('Server closed while opening project')
      }

      const { close } = createServer(project, this.channel, this.#opts)
      this.#server = { close }
      this.#project = project
      // `once`, not `on`: core's MapeoProject emits `close` twice (once from
      // `_close`, once from ready-resource).
      project.once('close', () => this.#onProjectClose(project))

      this.#state = 'open'
      this.#replay()
    } catch (err) {
      this.#state = 'dormant'
      this.#respondBufferedWithError(
        err instanceof Error ? err : new Error(String(err)),
      )
      throw err
    }
  }

  /**
   * `manager.getProject` returns the dying instance for the whole duration
   * of an in-flight close (its cache evicts only on the `close` event), so
   * wait out a close-in-progress and retry rather than binding to a corpse.
   *
   * @returns {Promise<MapeoProject>}
   */
  async #getOpenableProject() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const project = await this.#manager.getProject(this.#projectPublicId)
      if (project.closed) continue
      if (project.closing) {
        await Promise.resolve(project.closing).catch(noop)
        continue
      }
      return project
    }
    throw new Error(
      `Project ${this.#projectPublicId} kept closing while opening`,
    )
  }

  /**
   * Re-dispatch recorded subscriptions and buffered messages into the
   * freshly-bound server, in that order — a buffered write can cause events
   * the client is already subscribed to.
   */
  #replay() {
    this.#replaying = true
    try {
      for (const { eventName, propArray } of this.#tape.values()) {
        this.channel.dispatchEvent({ data: [MSG_ON, eventName, propArray] })
      }
      const pending = this.#buffer
      this.#buffer = []
      for (const data of pending) {
        this.channel.dispatchEvent({ data })
      }
    } finally {
      this.#replaying = false
    }
  }

  /**
   * Answer buffered calls with `err` through a transient stub server, so a
   * failed open (left project, unknown project) rejects the calls that
   * triggered it instead of leaving them to time out.
   *
   * @param {Error} err
   */
  #respondBufferedWithError(err) {
    const pending = this.#buffer
    this.#buffer = []
    const requests = pending.filter((data) => {
      const frame = unwrapFrame(data)
      return frame !== undefined && frame[0] === MSG_REQUEST
    })
    if (requests.length === 0) return

    const stub = createThrowingStub(() => err)
    const { close } = createServer(stub, this.channel, this.#opts)
    this.#replaying = true
    try {
      for (const data of requests) {
        this.channel.dispatchEvent({ data })
      }
    } finally {
      this.#replaying = false
      // Error responses are sent synchronously (the stub throws inside
      // `applyNestedMethod`), so the stub can be torn down immediately.
      close()
    }
  }

  /** @param {MapeoProject} project */
  #onProjectClose(project) {
    if (this.#project !== project) return
    this.#server?.close()
    this.#server = null
    this.#project = null
    if (!this.#closed) this.#state = 'dormant'
  }

  close() {
    this.#closed = true
    this.#server?.close()
    this.#server = null
    this.#project = null
    this.#buffer = []
    this.#tape.clear()
    this.channel.close()
  }
}

/**
 * Build a stub rpc-reflector handler whose every method (at any depth)
 * throws `makeError()` — rpc-reflector catches it and serializes it back to
 * the client as a standard error response. The outer target is a plain
 * object so the proxy passes rpc-reflector's `typeof handler === 'object'`
 * invariant; nested accesses return a function-target proxy so
 * `applyNestedMethod` finds `typeof === 'function'` and triggers the apply
 * trap.
 *
 * @param {() => Error} makeError
 */
function createThrowingStub(makeError) {
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
