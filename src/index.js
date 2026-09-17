export {
  createComapeoCoreClient,
  closeComapeoCoreClient,
  getComapeoCoreClientEvents,
  createComapeoServicesClient,
  closeComapeoServicesClient,
} from './client.js'
export {
  createComapeoCoreServer,
  createComapeoServicesServer,
} from './server.js'

/** @typedef {import('./client.js').ComapeoCoreClientApi} ComapeoCoreClientApi */
/** @typedef {import('./client.js').ComapeoCoreClientEmitter} ComapeoCoreClientEmitter */
/** @typedef {import('./client.js').ComapeoProjectClientApi} ComapeoProjectClientApi */
/** @typedef {import('./client.js').ComapeoServicesClientApi} ComapeoServicesClientApi */
/** @typedef {import('./lib/events.js').ComapeoCoreClientEvents} ComapeoCoreClientEvents */
/** @typedef {import('./server.js').ComapeoServicesApi} ComapeoServicesApi */
