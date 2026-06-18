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
 * Thrown client-side when a method is called after the MapeoManager client
 * (the whole IPC client) has been closed via `closeMapeoClient`.
 */
export const ClientClosedError = createErrorClass({
  code: 'CLIENT_CLOSED',
  message: 'CoMapeo client is closed',
  status: 410,
})
