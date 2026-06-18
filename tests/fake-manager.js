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
