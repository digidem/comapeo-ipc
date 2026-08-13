import { createErrorClass } from 'custom-error-creator'

export {
  ChannelClosedError as RpcChannelClosedError,
  TimeoutError as RpcTimeoutError,
} from 'rpc-reflector/errors.js'

/**
 * Thrown server-side when a stale call reaches a project instance that has
 * already been closed. Rides the standard rpc-reflector error response back
 * to the client.
 */
export const ProjectClosedError = createErrorClass({
  code: 'PROJECT_CLOSED',
  message: 'Project is closed',
  status: 410,
})

/**
 * Rejected client-side into calls that were in flight when the underlying
 * transport dropped (e.g. the process hosting the server was killed and
 * restarted). Distinguishable from a real failure or a timeout: the call
 * never completed on the server's side of the connection, so a read is safe
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
