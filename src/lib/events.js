/** @import { MapeoProject, MapeoManager } from '@comapeo/core' */

// A new core event must be added here. The lists are checked against
// core's emitter types.
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
