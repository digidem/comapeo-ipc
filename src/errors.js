import { createErrorClass } from 'custom-error-creator'

export {
  ChannelClosedError as RpcChannelClosedError,
  TimeoutError as RpcTimeoutError,
} from 'rpc-reflector/errors.js'

/**
 * Thrown server-side when a call arrives for a project this device has left
 * (`manager.leaveProject`). Left projects are never re-opened by the server;
 * re-joining via an invite (`manager.addProject`) makes the project usable
 * again. Rides the standard rpc-reflector error response back to the client.
 */
export const ProjectLeftError = createErrorClass({
  code: 'PROJECT_LEFT',
  message: 'This device has left the project',
  status: 410,
})

/**
 * Rejection for calls that were in flight when the transport to the server
 * dropped (e.g. the process hosting the server died). Distinguishable from
 * ordinary failures so callers can decide whether the call is safe
 * to retry once the transport has reconnected.
 */
export const TransportClosedError = createErrorClass({
  code: 'RPC_TRANSPORT_CLOSED',
  message:
    'Transport closed: the connection to the server dropped while the call was in flight',
  status: 503,
})

/**
 * Thrown client-side when a method is called after the CoMapeo core client
 * (the whole IPC client) has been closed via `closeComapeoCoreClient`.
 */
export const ClientClosedError = createErrorClass({
  code: 'CLIENT_CLOSED',
  message: 'CoMapeo client is closed',
  status: 410,
})
