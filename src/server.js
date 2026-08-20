import { EventEmitter } from 'events'
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
 * whose handler is a facade (see {@link ProjectHost}) that delegates to
 * whichever `MapeoProject` instance is live, opening one on demand. Clients
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

// These names are answered by the facade itself rather than delegated, so a
// project method sharing one would be shadowed — harmless, because
// rpc-reflector's client handles `prop in EventEmitter.prototype` locally and
// never sends such a call over the wire either way.
//
// EventEmitter methods that change which listeners are registered. After any
// of them the live instance's listeners are re-synced from the facade's own
// registry.
const EMITTER_MUTATORS = new Set([
  'addListener',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
  'removeListener',
  'off',
  'removeAllListeners',
])

// The subset of the above that expresses interest in events, and so wakes a
// dormant project. Unsubscribing alone is never a reason to open one.
const EMITTER_SUBSCRIBERS = new Set([
  'addListener',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
])

// Read-only EventEmitter methods, answered from the facade's registry.
const EMITTER_READERS = new Set([
  'listeners',
  'rawListeners',
  'listenerCount',
  'eventNames',
  'setMaxListeners',
  'getMaxListeners',
  'emit',
])

/**
 * Build the rpc-reflector handler for a project channel: one stable object
 * that outlives every `MapeoProject` instance served behind it.
 *
 * rpc-reflector asks only two things of a handler, both plain language-level
 * contracts rather than anything about its wire format: it *applies* method
 * paths to it (its client sends a request from a proxy apply trap, never from
 * a property read, so every request is a method call), and it *subscribes* to
 * it via `getNestedEventEmitter`, which walks the same path and requires an
 * `instanceof EventEmitter` at the end. So each node of the facade is a proxy
 * over a function — callable, so it can be a method; indexable, so it can be a
 * namespace; and reporting `EventEmitter.prototype`, so it can be subscribed
 * to.
 *
 * @param {object} owner
 * @param {(propArray: string[], args: ArrayLike<unknown>) => Promise<unknown>} owner.apply
 *   Delegate a method call to the live instance, opening one if needed.
 * @param {(propArray: string[]) => EventEmitter} owner.emitterFor
 *   The listener registry for a path; holds rpc-reflector's forwarding
 *   listeners across instances.
 * @param {(propArray: string[], opts: { wake: boolean }) => void} owner.onSubscriptionChange
 */
function createProjectFacade(owner) {
  /**
   * @param {string[]} propArray
   * @param {object | Function} target
   * @returns {any}
   */
  function node(propArray, target) {
    /** @type {any} */
    const proxy = new Proxy(target, {
      get(_target, prop) {
        // Symbols are never part of a reflected path, and a `then` node would
        // make the facade thenable to anything that awaits it.
        if (typeof prop !== 'string' || prop === 'then') return undefined

        if (EMITTER_MUTATORS.has(prop) || EMITTER_READERS.has(prop)) {
          return (/** @type {any[]} */ ...args) => {
            const emitter = /** @type {any} */ (owner.emitterFor(propArray))
            const result = Reflect.apply(emitter[prop], emitter, args)
            if (EMITTER_MUTATORS.has(prop)) {
              owner.onSubscriptionChange(propArray, {
                wake: EMITTER_SUBSCRIBERS.has(prop),
              })
            }
            // Keep EventEmitter's chainable contract pointing at the facade.
            return result === emitter ? proxy : result
          }
        }

        return node(propArray.concat(prop), function () {})
      },
      // Any path may exist; whether it really does is settled against the live
      // instance when the call is delegated.
      has() {
        return true
      },
      getPrototypeOf() {
        return EventEmitter.prototype
      },
      apply(_target, _thisArg, args) {
        return owner.apply(propArray, args)
      },
    })
    return proxy
  }

  // Object target at the root: rpc-reflector asserts `typeof handler ===
  // 'object'`.
  return node([], {})
}

/**
 * Walk a prop path on a live instance, raising the same errors rpc-reflector
 * does when it resolves a path on a handler, so a bad path fails the way it
 * did when the instance itself was the handler.
 *
 * @param {any} target
 * @param {string[]} propArray
 */
function walkPath(target, propArray) {
  let nested = target
  for (const propertyKey of propArray) {
    if (nested === null || nested === undefined) {
      throw new TypeError(`Cannot read property '${propertyKey}' of ${nested}`)
    }
    if (!Reflect.has(Object(nested), propertyKey)) {
      throw new ReferenceError(`${propertyKey} is not defined`)
    }
    nested = nested[propertyKey]
  }
  return nested
}

/**
 * Apply a method path to a live instance.
 *
 * @param {any} target
 * @param {string[]} propArray
 * @param {ArrayLike<unknown>} args
 */
function applyPath(target, propArray, args) {
  const propertyKey = propArray[propArray.length - 1]
  // rpc-reflector validates that a request carries a non-empty prop array.
  if (propertyKey === undefined) {
    throw new TypeError('[target] is not a function')
  }
  const nested = walkPath(target, propArray.slice(0, -1))
  if (nested === null || nested === undefined) {
    throw new TypeError(`Cannot read property '${propertyKey}' of ${nested}`)
  }
  if (typeof nested[propertyKey] !== 'function') {
    throw new ReferenceError(`${propertyKey} is not defined`)
  }
  return Reflect.apply(nested[propertyKey], nested, args)
}

/**
 * Resolve a prop path on a live instance to the EventEmitter at its end, or
 * undefined if the path doesn't exist or isn't an emitter.
 *
 * @param {any} target
 * @param {string[]} propArray
 * @returns {EventEmitter | undefined}
 */
function resolveEmitter(target, propArray) {
  try {
    const nested = walkPath(target, propArray)
    return nested instanceof EventEmitter ? nested : undefined
  } catch {
    return undefined
  }
}

/**
 * One per project public id, for the lifetime of the top-level server. Owns
 * the project's stable SubChannel, one long-lived rpc-reflector server bound
 * to it, and the open/close dance behind them:
 *
 * - **dormant** — no live instance. A delegated call (or a new subscription)
 *   triggers an open and waits for it.
 * - **opening** — `manager.getProject` in flight, behind the left-project
 *   guard. Concurrent callers await the same open.
 * - **open** — an instance is live and calls delegate straight to it.
 *
 * The rpc-reflector server never sees an instance: its handler is a facade
 * (see {@link createProjectFacade}) whose method calls await an open instance
 * and whose EventEmitter surface is this host's own listener registry. So
 * client subscriptions live on this side of the instance boundary, and are
 * (re-)attached to whichever instance is live — client listeners survive
 * server-side close/re-open cycles without knowing they happened. Because a
 * call cannot resolve before the open does, and the open attaches listeners
 * before it resolves, a call's events can never be missed.
 */
class ProjectHost {
  /** @type {'dormant' | 'opening' | 'open'} */
  #state = 'dormant'
  /** @type {Promise<MapeoProject> | null} */
  #openPromise = null
  /** @type {MapeoProject | null} */
  #project = null
  #closed = false

  /**
   * Encoded prop path → the listener registry rpc-reflector subscribes to.
   * Holds only rpc-reflector's forwarding listeners, never instance state.
   * @type {Map<string, EventEmitter>}
   */
  #subscriptions = new Map()
  /**
   * Encoded prop path → what is currently attached to the live instance, so
   * it can be detached exactly.
   * @type {Map<string, {
   *   emitter: EventEmitter,
   *   entries: Array<[string | symbol, (...args: any[]) => void]>,
   * }>}
   */
  #attached = new Map()

  #manager
  #projectPublicId
  /** @type {{ close: () => void }} */
  #server
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

    const facade = createProjectFacade({
      apply: (propArray, args) => this.#applyMethod(propArray, args),
      emitterFor: (propArray) => this.#emitterFor(propArray),
      onSubscriptionChange: (propArray, { wake }) =>
        this.#syncSubscriptions(propArray, { wake }),
    })

    this.channel = new SubChannel(
      messagePort,
      `${PROJECT_CHANNEL_PREFIX}${projectPublicId}`,
    )
    // Bound before `start()`, so the first frame — which the top-level router
    // hands to the channel directly — reaches the rpc server.
    this.#server = createServer(facade, this.channel, opts)
    this.channel.start()
  }

  /**
   * Ensure a live instance is bound to this project's channel, opening it if
   * necessary. Resolves once calls can be served; rejects with
   * `ProjectLeftError` for left projects or whatever `manager.getProject`
   * throws (e.g. `NotFoundError`). Safe to call concurrently.
   *
   * @returns {Promise<void>}
   */
  async open() {
    await this.#ensureOpen()
  }

  close() {
    // Closed first so rpc-reflector unsubscribes through the facade while the
    // instance is still live, detaching cleanly.
    this.#server.close()
    this.#closed = true
    this.#detachAll()
    this.#subscriptions.clear()
    this.#project = null
    this.#state = 'dormant'
    this.channel.close()
  }

  /**
   * @param {string[]} propArray
   * @param {ArrayLike<unknown>} args
   */
  async #applyMethod(propArray, args) {
    const project = await this.#ensureOpen()
    return applyPath(project, propArray, args)
  }

  /**
   * @param {string[]} propArray
   * @returns {EventEmitter}
   */
  #emitterFor(propArray) {
    const key = JSON.stringify(propArray)
    let emitter = this.#subscriptions.get(key)
    if (!emitter) {
      emitter = new EventEmitter()
      // One listener per (path, event) comes from rpc-reflector, but the
      // consumer's own limit shouldn't produce warnings here.
      emitter.setMaxListeners(0)
      this.#subscriptions.set(key, emitter)
    }
    return emitter
  }

  /**
   * @param {string[]} propArray
   * @param {{ wake: boolean }} options
   */
  #syncSubscriptions(propArray, { wake }) {
    if (this.#closed) return
    const key = JSON.stringify(propArray)
    if (this.#state === 'open' && this.#project) {
      this.#detachPath(key)
      this.#attachPath(key, this.#project)
    } else if (wake) {
      // Subscribing expresses interest in a project, so it opens one.
      this.#ensureOpen().catch(noop)
    }
  }

  /**
   * @param {string} key
   * @param {MapeoProject} project
   */
  #attachPath(key, project) {
    const registry = this.#subscriptions.get(key)
    if (!registry) return
    const emitter = resolveEmitter(project, JSON.parse(key))
    if (!emitter) return

    /** @type {Array<[string | symbol, (...args: any[]) => void]>} */
    const entries = []
    for (const eventName of registry.eventNames()) {
      for (const listener of registry.rawListeners(eventName)) {
        const fn = /** @type {(...args: any[]) => void} */ (listener)
        emitter.on(eventName, fn)
        entries.push([eventName, fn])
      }
    }
    if (entries.length > 0) this.#attached.set(key, { emitter, entries })
  }

  /** @param {string} key */
  #detachPath(key) {
    const record = this.#attached.get(key)
    if (!record) return
    for (const [eventName, listener] of record.entries) {
      record.emitter.removeListener(eventName, listener)
    }
    this.#attached.delete(key)
  }

  /** @param {MapeoProject} project */
  #attachAll(project) {
    for (const key of this.#subscriptions.keys()) {
      this.#detachPath(key)
      this.#attachPath(key, project)
    }
  }

  #detachAll() {
    for (const key of [...this.#attached.keys()]) {
      this.#detachPath(key)
    }
  }

  /** @returns {Promise<MapeoProject>} */
  #ensureOpen() {
    if (this.#closed) {
      return Promise.reject(new Error('Project host is closed'))
    }
    if (this.#state === 'open' && this.#project) {
      return Promise.resolve(this.#project)
    }
    if (this.#openPromise) return this.#openPromise

    const openPromise = this.#doOpen().finally(() => {
      if (this.#openPromise === openPromise) this.#openPromise = null
    })
    this.#openPromise = openPromise
    // Subscription-triggered opens have no awaiter; keep a rejection from
    // surfacing as an unhandled rejection without detaching other awaiters.
    openPromise.catch(noop)
    return openPromise
  }

  /** @returns {Promise<MapeoProject>} */
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

      this.#project = project
      // `once`, not `on`: core's MapeoProject emits `close` twice (once from
      // `_close`, once from ready-resource).
      project.once('close', () => this.#onProjectClose(project))
      // Before the state flips to open, so no delegated call can run against
      // an instance whose listeners aren't attached yet.
      this.#attachAll(project)

      this.#state = 'open'
      return project
    } catch (err) {
      this.#state = 'dormant'
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

  /** @param {MapeoProject} project */
  #onProjectClose(project) {
    if (this.#project !== project) return
    this.#detachAll()
    this.#project = null
    if (!this.#closed) this.#state = 'dormant'
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
