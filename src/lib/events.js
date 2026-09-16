import { deserializeError, serializeError } from 'serialize-error'

/** @import { PublicPeerInfo, MapShare, MapShareExtension, RoleChangeEvent, InviteApi, MapeoProject, MapeoManager } from '@comapeo/core' */

// A new core event must be added here and to `ComapeoCoreClientEvents`. The
// lists are checked against core's emitter types.
export const MANAGER_EVENTS =
  /** @satisfies {ReadonlyArray<Parameters<MapeoManager['on']>[0]>} */ (
    /** @type {const} */ (['local-peers', 'map-share', 'map-share-error'])
  )
export const INVITE_EVENTS =
  /** @satisfies {ReadonlyArray<Parameters<MapeoManager['invite']['on']>[0]>} */ (
    /** @type {const} */ (['invite-received', 'invite-updated'])
  )
export const PROJECT_EVENTS =
  /** @satisfies {ReadonlyArray<Parameters<MapeoProject['on']>[0]>} */ (
    /** @type {const} */ (['own-role-change'])
  )
export const SYNC_EVENTS =
  /** @satisfies {ReadonlyArray<Parameters<MapeoProject['$sync']['on']>[0]>} */ (
    /** @type {const} */ (['sync-state'])
  )

export const PROJECT_EVENT_PREFIX = 'project:'

/** @type {ReadonlySet<string>} */
const CLIENT_EVENT_NAMES = new Set([
  ...MANAGER_EVENTS,
  ...INVITE_EVENTS,
  ...[...PROJECT_EVENTS, ...SYNC_EVENTS].map((e) => PROJECT_EVENT_PREFIX + e),
])

/** @typedef {Awaited<ReturnType<MapeoProject['$sync']['getState']>>} SyncState */

/**
 * Events delivered by `getComapeoCoreClientEvents`. Manager and invite events keep their
 * core names and listener arguments. Project-scoped events are prefixed with
 * `project:` and receive the project's public id as their first argument,
 * because one channel carries the events of every project.
 *
 * @typedef {{
 *   'local-peers': (peers: PublicPeerInfo[]) => void,
 *   'map-share': (mapShare: MapShare) => void,
 *   'map-share-error': (error: Error, mapShare: MapShareExtension) => void,
 *   'invite-received': (invite: InviteApi.Invite) => void,
 *   'invite-updated': (invite: InviteApi.Invite) => void,
 *   'project:own-role-change': (projectId: string, changeEvent: RoleChangeEvent) => void,
 *   'project:sync-state': (projectId: string, state: SyncState) => void,
 * }} ComapeoCoreClientEvents
 */

/**
 * What the server posts on the events channel.
 *
 * @typedef {object} EventFrame
 * @property {string} event Core event name, without any prefix
 * @property {string} [projectId] Set for project-scoped events
 * @property {unknown[]} args Listener arguments
 * @property {number[]} [errorIndexes] Positions in `args` holding a serialized `Error`
 */

/**
 * @param {string} event
 * @param {unknown[]} args
 * @param {string} [projectId]
 * @returns {EventFrame}
 */
export function encodeEventFrame(event, args, projectId) {
  /** @type {number[]} */
  const errorIndexes = []
  const encodedArgs = args.map((arg, index) => {
    if (!(arg instanceof Error)) return arg
    errorIndexes.push(index)
    return serializeError(arg)
  })
  /** @type {EventFrame} */
  const frame = { event, args: encodedArgs }
  if (projectId !== undefined) frame.projectId = projectId
  if (errorIndexes.length > 0) frame.errorIndexes = errorIndexes
  return frame
}

/**
 * An event name paired with the arguments its listeners receive.
 *
 * @typedef {{
 *   [E in keyof ComapeoCoreClientEvents]: {
 *     event: E,
 *     args: Parameters<ComapeoCoreClientEvents[E]>,
 *   }
 * }[keyof ComapeoCoreClientEvents]} DecodedEvent
 */

/**
 * Turn a received frame into the event to emit on the client emitter. Returns
 * `null` for a malformed frame or an unknown event name.
 *
 * @param {unknown} data
 * @returns {DecodedEvent | null}
 */
export function decodeEventFrame(data) {
  if (!isEventFrame(data)) return null
  const args = data.args.map((arg, index) =>
    data.errorIndexes?.includes(index) ? deserializeError(arg) : arg,
  )
  const event =
    data.projectId === undefined
      ? data.event
      : PROJECT_EVENT_PREFIX + data.event
  if (!isClientEventName(event)) return null
  // Only the name is checked; argument types are trusted from the wire.
  return /** @type {DecodedEvent} */ ({
    event,
    args: data.projectId === undefined ? args : [data.projectId, ...args],
  })
}

/**
 * @param {string} event
 * @returns {event is keyof ComapeoCoreClientEvents}
 */
function isClientEventName(event) {
  return CLIENT_EVENT_NAMES.has(event)
}

/**
 * @param {unknown} data
 * @returns {data is EventFrame}
 */
function isEventFrame(data) {
  if (!data || typeof data !== 'object') return false
  if (!('event' in data) || typeof data.event !== 'string') return false
  if (!('args' in data) || !Array.isArray(data.args)) return false
  if (
    'projectId' in data &&
    data.projectId !== undefined &&
    typeof data.projectId !== 'string'
  ) {
    return false
  }
  if (
    'errorIndexes' in data &&
    data.errorIndexes !== undefined &&
    !Array.isArray(data.errorIndexes)
  ) {
    return false
  }
  return true
}

/**
 * @typedef {object} EmitterLike
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} removeListener
 */

/**
 * @param {unknown} value
 * @returns {value is EmitterLike}
 */
function isEmitterLike(value) {
  if (!value || typeof value !== 'object') return false
  return (
    'on' in value &&
    typeof value.on === 'function' &&
    'removeListener' in value &&
    typeof value.removeListener === 'function'
  )
}

/**
 * Forward each of `eventNames` emitted by `emitter` to `post`. Returns a
 * function that removes the listeners again.
 *
 * @param {unknown} emitter
 * @param {ReadonlyArray<string>} eventNames
 * @param {(event: string, args: unknown[]) => void} post
 * @returns {() => void}
 */
export function relayEvents(emitter, eventNames, post) {
  if (!isEmitterLike(emitter)) return () => {}
  const entries = eventNames.map((event) => {
    /** @param {unknown[]} args */
    const listener = (...args) => post(event, args)
    emitter.on(event, listener)
    return /** @type {const} */ ([event, listener])
  })
  return () => {
    for (const [event, listener] of entries) {
      emitter.removeListener(event, listener)
    }
  }
}
