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
 * Thrown client-side when a method is called after the CoMapeo core client
 * (the whole IPC client) has been closed via `closeComapeoCoreClient`.
 */
export const ClientClosedError = createErrorClass({
  code: 'CLIENT_CLOSED',
  message: 'CoMapeo client is closed',
  status: 410,
})
