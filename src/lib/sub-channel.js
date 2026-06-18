import { isRelevantEventData } from './utils.js'

// Shared prefix on every channel id this library mints. It lets the server
// tell its own traffic from a foreign sender sharing the same port: an id
// without this prefix isn't ours and is ignored without warning.
export const COMAPEO_PREFIX = '@@comapeo/'

export const MANAGER_CHANNEL_ID = '@@comapeo/manager'
export const PROJECT_ROUTING_ID = '@@comapeo/project-routing'
export const SERVICES_ID = '@@comapeo/services'

// Prefix for per-project instance channel ids; the rest of the id is the
// project's public id plus a per-open counter (see `openProjectInstance`).
export const PROJECT_INSTANCE_PREFIX = '@@comapeo/project/'

/** @import {MessagePortLike, MessageEvent} from 'rpc-reflector' */

/**
 * @typedef {Object} Events
 * @property {(message: unknown) => void} message
 */

/** @implements {MessagePortLike} */
export class SubChannel {
  #id
  #messagePort
  /** @type {'idle' | 'active' | 'closed'} */
  #state
  /** @type {Array<{id: string, message: unknown}>} */
  #queued
  #handleMessageEvent

  /** @type {Set<(message: MessageEvent) => void>} */
  #listeners = new Set()

  /**
   * @param {MessagePortLike} messagePort Parent channel to add namespace to
   * @param {string} id ID for the subchannel
   */
  constructor(messagePort, id) {
    this.#id = id
    this.#messagePort = messagePort
    this.#state = 'idle'
    this.#queued = []

    /**
     * @param {{ data: unknown }} event
     */
    this.#handleMessageEvent = ({ data }) => {
      if (!isRelevantEventData(data)) return

      const { id, message } = data

      if (this.#id !== id) return

      switch (this.#state) {
        case 'idle': {
          this.#queued.push(data)
          break
        }
        case 'active': {
          this.dispatchEvent({ data: message })
          break
        }
        case 'closed': {
          // no-op if closed (the event listener should be removed anyway)
          break
        }
      }
    }

    this.#messagePort.addEventListener('message', this.#handleMessageEvent)
  }

  /**
   * @param {'message'} type
   * @param {(event: MessageEvent) => void} listener
   */
  addEventListener(type, listener) {
    if (type !== 'message') return
    this.#listeners.add(listener)
  }

  /**
   * @param {'message'} type
   * @param {(event: MessageEvent) => void} listener
   */
  removeEventListener(type, listener) {
    if (type !== 'message') return
    this.#listeners.delete(listener)
  }

  get id() {
    return this.#id
  }

  /**
   * Send messages with the subchannel's ID
   * @param {any} message
   */
  postMessage(message) {
    this.#messagePort.postMessage({ id: this.#id, message })
  }

  start() {
    if (this.#state !== 'idle') return

    this.#state = 'active'

    /** @type {{id: string, message: unknown} | undefined} */
    let data
    while ((data = this.#queued.shift())) {
      this.#handleMessageEvent({ data })
    }
  }

  close() {
    if (this.#state === 'closed') return

    this.#state = 'closed'
    this.#queued = []

    // Node types are incorrect (as of v14, Node's MessagePort should also extend [EventTarget](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget))
    this.#messagePort.removeEventListener('message', this.#handleMessageEvent)
  }

  /** @param {MessageEvent} event */
  dispatchEvent(event) {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}
