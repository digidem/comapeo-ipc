import { createErrorClass } from 'custom-error-creator'

export {
  ChannelClosedError as RpcChannelClosedError,
  TimeoutError as RpcTimeoutError,
} from 'rpc-reflector/errors.js'

/**
 * Thrown client-side when a method is called after the CoMapeo core client
 * (the whole IPC client) has been closed via `closeComapeoCoreClient`.
 */
export const ClientClosedError = createErrorClass({
  code: 'CLIENT_CLOSED',
  message: 'CoMapeo client is closed',
  status: 410,
})
