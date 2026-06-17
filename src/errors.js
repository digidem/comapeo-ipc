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
