import { isRelevantEventData } from './utils.js'

// Ideally unique ID used for identifying "global" Mapeo IPC messages
export const MAPEO_RPC_ID = '@@mapeo-rpc'
export const APP_RPC_ID = '@@app-rpc'
export const MANAGER_CHANNEL_ID = '@@manager'

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
