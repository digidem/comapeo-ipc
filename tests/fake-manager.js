import { EventEmitter } from 'node:events'
import { NotFoundError } from '@comapeo/core/errors.js'

/**
 * In-memory stand-ins for `@comapeo/core`'s `MapeoManager` / `MapeoProject`,
 * exposing only the surface the IPC tests exercise. They let the IPC layer be
 * tested in isolation from core: faster, hermetic, and free of core's internal
 * retention behaviour (which previously forced the cycle-retention test to
 * tolerate one surviving instance — see tests/project-close.js).
 *
 * Like their core counterparts they are `EventEmitter`s (as are `invite` and
 * `$sync`), so the IPC server can relay their events and observe a project's
 * `close`.
 */

/**
 * @typedef {object} ProjectStore
 * @property {Record<string, unknown>} settings
 * @property {Map<string, Record<string, unknown>>} observations
 * @property {number} obsCounter
 */

class FakeSyncApi extends EventEmitter {
  /** @type {Record<string, unknown>} */
  #state = { data: { isSyncEnabled: false } }

  async getState() {
    return this.#state
  }

  /**
   * Replace the state and emit `sync-state`, as core does on every change.
   * @param {Record<string, unknown>} state
   */
  setState(state) {
    this.#state = state
    this.emit('sync-state', state)
  }
}

class FakeProject extends EventEmitter {
  /** @type {ProjectStore} */
  #store
  #closed = false
  $sync = new FakeSyncApi()

  /** @param {ProjectStore} store */
  constructor(store) {
    super()
    this.#store = store

    /**
     * @type {{
     *   create: (value: Record<string, unknown>) => Promise<Record<string, unknown>>,
     *   getByDocId: (docId: string) => Promise<Record<string, unknown>>,
     * }}
     */
    this.observation = {
      create: async (value) => {
        const docId = `obs-${++store.obsCounter}`
        const doc = { ...value, docId }
        store.observations.set(docId, doc)
        return doc
      },
      getByDocId: async (docId) => {
        const doc = store.observations.get(docId)
        if (!doc) throw new NotFoundError(`No observation with docId ${docId}`)
        return doc
      },
    }
  }

  async $getProjectSettings() {
    return { ...this.#store.settings }
  }

  /**
   * A mutation that emits during the call, like core's role changes do.
   * @param {string} roleId
   */
  async setOwnRole(roleId) {
    const changeEvent = { roleId }
    this.emit('own-role-change', changeEvent)
    return changeEvent
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.emit('close')
  }
}

export class FakeManager extends EventEmitter {
  /** @type {Map<string, ProjectStore>} */
  #stores = new Map()
  /** @type {Map<string, FakeProject>} */
  #liveProjects = new Map()
  #projectCounter = 0

  /** Mirrors `manager.invite`: the emitter for invite events. */
  invite = new EventEmitter()

  /**
   * Per-projectId count of `getProject` calls that opened a server-side
   * instance. Used to assert that concurrent/repeated `getProject` calls are
   * deduplicated to a single open.
   * @type {Map<string, number>}
   */
  getProjectCallCount = new Map()

  isArchiveDevice = true

  /**
   * @param {{
   *   name?: string,
   *   configMetadata?: unknown,
   *   defaultPresets?: unknown,
   *   projectColor?: unknown,
   *   projectDescription?: unknown,
   * }} [settings]
   * @returns {Promise<string>}
   */
  async createProject(settings = {}) {
    const projectId = `project-${++this.#projectCounter}`
    this.#stores.set(projectId, {
      settings: {
        name: settings.name,
        configMetadata: settings.configMetadata,
        defaultPresets: settings.defaultPresets,
        projectColor: settings.projectColor,
        projectDescription: settings.projectDescription,
        sendStats: false,
      },
      observations: new Map(),
      obsCounter: 0,
    })
    return projectId
  }

  /**
   * @param {string} projectId
   * @returns {Promise<FakeProject>}
   */
  async getProject(projectId) {
    this.getProjectCallCount.set(
      projectId,
      (this.getProjectCallCount.get(projectId) ?? 0) + 1,
    )

    const store = this.#stores.get(projectId)
    if (!store) throw new NotFoundError(`Project ${projectId} does not exist`)

    // Mirror core: while a project is open, `getProject` returns the same live
    // instance; once it closes, the instance is released so a later
    // `getProject` opens a fresh one.
    let project = this.#liveProjects.get(projectId)
    if (!project) {
      project = new FakeProject(store)
      const liveProject = project
      this.#liveProjects.set(projectId, liveProject)
      liveProject.once('close', () => {
        if (this.#liveProjects.get(projectId) === liveProject) {
          this.#liveProjects.delete(projectId)
        }
      })
    }
    return project
  }

  /**
   * Permanently remove a project: close its live instance (if open) and
   * delete its store so subsequent `getProject` calls throw `NotFoundError`.
   * Unlike `close()`, the project cannot be re-opened.
   * @param {string} projectId
   */
  async deleteProject(projectId) {
    const live = this.#liveProjects.get(projectId)
    if (live) await live.close()
    this.#stores.delete(projectId)
  }

  async listProjects() {
    return [...this.#stores.entries()].map(([projectId, store]) => ({
      projectId,
      name: store.settings.name,
    }))
  }

  async getIsArchiveDevice() {
    return this.isArchiveDevice
  }
}
