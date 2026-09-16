import { createClient } from 'rpc-reflector/client.js'
import { EventEmitter } from 'eventemitter3'

import {
  EVENTS_ID,
  MANAGER_CHANNEL_ID,
  PROJECT_ROUTING_ID,
  SERVICES_ID,
  SubChannel,
} from './lib/sub-channel.js'
import { ClientClosedError } from './errors.js'
import { decodeEventFrame } from './lib/events.js'
import {
  isReflectedEmitterMethod,
  withoutReflectedEmitter,
} from './lib/reflected-emitter.js'

/** @import { ClientApi, MessagePortLike } from 'rpc-reflector' */
/** @import { MapeoProject, MapeoManager } from '@comapeo/core' */
/** @import { ComapeoServicesApi } from './server.js' */
/** @import { ComapeoCoreClientEvents } from './lib/events.js' */
/** @import { WithoutEmitter } from './lib/reflected-emitter.js' */

/**
 * Build the Proxy returned for a closed client reference. Method calls
 * (including nested namespaces) reject with `makeError()`, keeping the
 * `Promise`-returning contract callers expect.
 *
 * @param {() => Error} makeError
 */
function createClosedProxy(makeError) {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get() {
      return new Proxy(function () {}, handler)
    },
    has() {
      return true
    },
    apply() {
      return Promise.reject(makeError())
    },
  }
  return new Proxy({}, handler)
}

/** @typedef {WithoutEmitter<ClientApi<MapeoProject>>} ComapeoProjectClientApi */

/** @typedef {EventEmitter<ComapeoCoreClientEvents>} ComapeoCoreClientEmitter */

/**
 * @typedef {Omit<WithoutEmitter<ClientApi<MapeoManager>>, 'getProject'> & {
 *   getProject: (projectPublicId: string) => Promise<ComapeoProjectClientApi>,
 * }} ComapeoCoreClientApi
 */

const CLOSE = Symbol('close')
const EVENTS = Symbol('events')

/**
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 *
 * @returns {ComapeoCoreClientApi}
 */
export function createComapeoCoreClient(messagePort, opts = {}) {
  /**
   * projectPublicId → wrapper. Cached for the life of the connection and never
   * evicted: a closed project is transparently re-opened server-side on the
   * next call, so the same wrapper (and its subchannel) stays valid across
   * close/re-open cycles.
   * @type {Map<string, ComapeoProjectClientApi>}
   */
  const currentProjectClients = new Map()

  /**
   * projectPublicId → in-flight `getProject`. Dedupes concurrent calls;
   * entries are removed on settle so later calls re-check the cache.
   * @type {Map<string, Promise<ComapeoProjectClientApi>>}
   */
  const pendingProjectClients = new Map()

  /**
   * The rpc-reflector client + SubChannel pair for every project wrapper ever
   * created. Entries are closed by `closeComapeoCoreClient`.
   * @type {Set<{
   *   client: ComapeoProjectClientApi,
   *   channel: SubChannel,
   * }>}
   */
  const openProjectClients = new Set()

  const managerChannel = new SubChannel(messagePort, MANAGER_CHANNEL_ID)
  const projectRoutingChannel = new SubChannel(messagePort, PROJECT_ROUTING_ID)
  const eventsChannel = new SubChannel(messagePort, EVENTS_ID)

  /** @type {ClientApi<MapeoManager>} */
  const managerClient = withoutReflectedEmitter(
    createClient(managerChannel, opts),
  )
  /** @type {ClientApi<import('./server.js').ProjectRoutingApi>} */
  const projectRoutingClient = createClient(projectRoutingChannel, opts)

  /** @type {ComapeoCoreClientEmitter} */
  const events = new EventEmitter()
  eventsChannel.addEventListener('message', ({ data }) => {
    const decoded = decodeEventFrame(data)
    if (!decoded) return
    events.emit(decoded.event, ...decoded.args)
  })

  projectRoutingChannel.start()
  managerChannel.start()
  eventsChannel.start()

  // Set once `closeComapeoCoreClient` has torn the whole client down. Read by
  // the manager proxy so that calls after close surface `ClientClosedError`
  // instead of rpc-reflector's `ChannelClosed`. Per-project wrappers are left
  // to their own (now-closed) subchannels, which reject with
  // `RpcChannelClosedError`.
  let clientClosed = false
  const managerClosedProxy = createClosedProxy(() => new ClientClosedError())

  const client = new Proxy(managerClient, {
    get(target, prop, receiver) {
      if (prop === CLOSE) {
        return async () => {
          managerChannel.close()
          createClient.close(managerClient)

          // Wait for any in-flight project creations to settle before
          // closing project clients. `openProjectClients` is populated
          // synchronously after `assertProjectExists` resolves, so any
          // creation that hasn't settled yet isn't in the registry.
          await Promise.allSettled(pendingProjectClients.values())

          for (const entry of openProjectClients) {
            createClient.close(entry.client)
            entry.channel.close()
          }
          openProjectClients.clear()

          // Closed last so in-flight `assertProjectExists` calls awaited
          // above can complete rather than reject.
          projectRoutingChannel.close()
          createClient.close(projectRoutingClient)
          eventsChannel.close()

          clientClosed = true
        }
      }

      if (prop === EVENTS) {
        return events
      }

      if (prop === 'getProject') {
        return createProjectClient
      }

      // Throws the same "use getComapeoCoreClientEvents" error before and after close
      if (isReflectedEmitterMethod(prop)) {
        return Reflect.get(target, prop, receiver)
      }

      // `then` must stay falsy so awaiting the client (a thenable check) does
      // not route into the throwing proxy.
      if (clientClosed && prop !== 'then') {
        return Reflect.get(managerClosedProxy, prop)
      }

      return Reflect.get(target, prop, receiver)
    },
  })

  // TS can't know the type of the proxy, so we cast it in the function return
  return /** @type {any} */ (client)

  /**
   * @param {string} projectPublicId
   * @returns {Promise<ComapeoProjectClientApi>}
   */
  async function createProjectClient(projectPublicId) {
    // Checked before the cache lookup so `getProject` rejects uniformly after
    // close — whether or not this id was fetched (and cached) earlier.
    if (clientClosed) throw new ClientClosedError()

    const pending = pendingProjectClients.get(projectPublicId)
    if (pending) return pending

    const promise = resolveProjectClient(projectPublicId)
    pendingProjectClients.set(projectPublicId, promise)
    try {
      return await promise
    } finally {
      pendingProjectClients.delete(projectPublicId)
    }
  }

  /**
   * Return the cached wrapper if present; otherwise ask the server to
   * validate the project (which yields the stable subchannel id) and build +
   * cache a fresh wrapper.
   *
   * @param {string} projectPublicId
   * @returns {Promise<ComapeoProjectClientApi>}
   */
  async function resolveProjectClient(projectPublicId) {
    const cached = currentProjectClients.get(projectPublicId)
    if (cached) return cached

    const instanceId =
      await projectRoutingClient.assertProjectExists(projectPublicId)

    const wrapper = createProjectClientWrapper(instanceId)
    currentProjectClients.set(projectPublicId, wrapper)
    return wrapper
  }

  /**
   * Build the rpc-reflector client bound to the project's (stable) subchannel
   * and register it for teardown. No `close` interception: a `close()` call
   * simply invokes the project's remote `close`, and the subchannel stays open
   * so a later call transparently re-opens the project server-side.
   *
   * @param {string} instanceId
   * @returns {ComapeoProjectClientApi}
   */
  function createProjectClientWrapper(instanceId) {
    const projectChannel = new SubChannel(messagePort, instanceId)

    /** @type {ComapeoProjectClientApi} */
    const projectClient = withoutReflectedEmitter(
      /** @type {ClientApi<MapeoProject>} */ (
        createClient(projectChannel, opts)
      ),
    )
    projectChannel.start()

    openProjectClients.add({ client: projectClient, channel: projectChannel })

    return projectClient
  }
}

/**
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 * @returns {Promise<void>}
 */
export async function closeComapeoCoreClient(client) {
  // @ts-expect-error
  return client[CLOSE]()
}

/**
 * Server events (manager, invite and project events) are delivered here; see
 * `ComapeoCoreClientEvents` for the event map.
 *
 * @param {ComapeoCoreClientApi} client client created with `createComapeoCoreClient`
 * @returns {ComapeoCoreClientEmitter}
 */
export function getComapeoCoreClientEvents(client) {
  // @ts-expect-error
  return client[EVENTS]
}

/**
 * @typedef {ClientApi<ComapeoServicesApi>} ComapeoServicesClientApi
 */

/**
 * Create a client for the app-provided services that live outside
 * `@comapeo/core` — the map server today, and the blob and icon servers in the
 * future (once extracted from core). The host app implements the server side;
 * see {@link ComapeoServicesApi}.
 *
 * @param {MessagePortLike} messagePort
 * @param {Parameters<typeof createClient>[1]} [opts]
 * @return {ComapeoServicesClientApi}
 */
export function createComapeoServicesClient(messagePort, opts = {}) {
  const servicesChannel = new SubChannel(messagePort, SERVICES_ID)
  const servicesClient = /** @type {ComapeoServicesClientApi} */ (
    createClient(servicesChannel, opts)
  )
  servicesChannel.start()
  return servicesClient
}

/**
 * Close the services client (removes listeners but does not close the message port)
 *
 * @param {ComapeoServicesClientApi} servicesClient client created with `createComapeoServicesClient`
 */
export function closeComapeoServicesClient(servicesClient) {
  createClient.close(servicesClient)
}
