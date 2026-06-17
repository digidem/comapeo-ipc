export {
  createMapeoClient,
  closeMapeoClient,
  createAppRpcClient,
  closeAppRpcClient,
} from './client.js'
export { createMapeoServer, createAppRpcServer } from './server.js'

/** @typedef {import('./client.js').MapeoClientApi} MapeoClientApi */
/** @typedef {import('./client.js').MapeoProjectApi} MapeoProjectApi */
/**
 * @template [T=unknown]
 * @typedef {import('./client.js').AppRpcClientApi<T>} AppRpcClientApi
 */
