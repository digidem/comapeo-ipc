import { EventEmitter } from 'node:events'
import { NotFoundError } from '@comapeo/core/errors.js'

/**
 * In-memory stand-ins for `@comapeo/core`'s `MapeoManager` / `MapeoProject`,
 * exposing only the surface the IPC tests exercise. They let the IPC layer be
 * tested in isolation from core: faster, hermetic, and free of core's internal
 * retention behaviour (which previously forced the cycle-retention test to
 * tolerate one surviving instance — see tests/project-close.js).
 *
 * Both extend Node's `EventEmitter` so that rpc-reflector can forward events
 * (`getNestedEventEmitter` does an `instanceof EventEmitter` check) and so the
 * IPC server's `project.once('close')` works.
 */

/**
 * @typedef {object} ProjectStore
 * @property {Record<string, unknown>} settings
 * @property {Map<string, Record<string, unknown>>} observations
 * @property {number} obsCounter
 */

class FakeProject extends EventEmitter {
  /** @type {ProjectStore} */
  #store
  #closed = false

  /** @param {ProjectStore} store */
  constructor(store) {
    super()
    this.#store = store

    // Mirror core's DataType: a nested namespace that is itself an emitter,
    // emitting 'updated-docs' on writes.
    const observation = Object.assign(new EventEmitter(), {
      /** @param {Record<string, unknown>} value */
      create: async (value) => {
        const docId = `obs-${++store.obsCounter}`
        const doc = { ...value, docId }
        store.observations.set(docId, doc)
        observation.emit('updated-docs', [doc])
        return doc
      },
      /** @param {string} docId */
      getByDocId: async (docId) => {
        const doc = store.observations.get(docId)
        if (!doc) throw new NotFoundError(`No observation with docId ${docId}`)
        return doc
      },
    })
    this.observation = observation
  }

  async $getProjectSettings() {
    return { ...this.#store.settings }
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

  /**
   * Per-projectId count of `getProject` calls that opened a server-side
   * instance. Used to assert that concurrent/repeated `getProject` calls are
   * deduplicated to a single open.
   * @type {Map<string, number>}
   */
  getProjectCallCount = new Map()

  /**
   * Per-projectId count of live instances constructed, i.e. server-side opens
   * (a `getProject` that returns an already-open instance does not count).
   * @type {Map<string, number>}
   */
  projectOpenCount = new Map()

  /**
   * projectId → error to throw from the next `getProject` call, simulating a
   * transient failure. Cleared once thrown.
   * @type {Map<string, Error>}
   */
  #nextGetProjectError = new Map()

  /**
   * Make the next `getProject(projectId)` throw `error` (once).
   * @param {string} projectId
   * @param {Error} error
   */
  failNextGetProject(projectId, error) {
    this.#nextGetProjectError.set(projectId, error)
  }

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

    const transientError = this.#nextGetProjectError.get(projectId)
    if (transientError) {
      this.#nextGetProjectError.delete(projectId)
      throw transientError
    }

    const store = this.#stores.get(projectId)
    if (!store) throw new NotFoundError(`Project ${projectId} does not exist`)

    // Mirror core: while a project is open, `getProject` returns the same live
    // instance; once it closes, the instance is released so a later
    // `getProject` opens a fresh one.
    let project = this.#liveProjects.get(projectId)
    if (!project) {
      this.projectOpenCount.set(
        projectId,
        (this.projectOpenCount.get(projectId) ?? 0) + 1,
      )
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
