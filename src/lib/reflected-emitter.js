// Temporary: goes away once rpc-reflector stops reflecting EventEmitter
// methods onto client proxies.

const REFLECTED_EMITTER_METHODS = /** @type {const} */ ([
  'addListener',
  'on',
  'once',
  'removeListener',
  'off',
  'removeAllListeners',
  'emit',
  'eventNames',
  'listeners',
  'rawListeners',
  'listenerCount',
])
/** @typedef {(typeof REFLECTED_EMITTER_METHODS)[number]} ReflectedEmitterMethod */
/** @type {ReadonlySet<string>} */
const reflectedEmitterMethods = new Set(REFLECTED_EMITTER_METHODS)

/**
 * Strip the reflected EventEmitter methods from a client type and every
 * namespace nested in it. Methods (no keys) pass through unchanged.
 *
 * @template T
 * @typedef {[keyof T] extends [never]
 *   ? T
 *   : { [K in keyof T as Exclude<K, ReflectedEmitterMethod>]: WithoutEmitter<T[K]> }} WithoutEmitter
 */

/**
 * @param {string | symbol} prop
 * @returns {boolean}
 */
export function isReflectedEmitterMethod(prop) {
  return typeof prop === 'string' && reflectedEmitterMethods.has(prop)
}

/** @param {string} method */
function reflectedEmitterError(method) {
  return new TypeError(
    `${method}() is not available on the IPC client: use getComapeoCoreClientEvents(client)`,
  )
}

/** @type {WeakMap<object, any>} */
const eventlessProxies = new WeakMap()

/**
 * Wrap a reflected object so its EventEmitter methods throw instead of
 * subscribing over the wire. Nested namespaces are wrapped as they are
 * accessed.
 *
 * @template {object} T
 * @param {T} target
 * @returns {T}
 */
export function withoutReflectedEmitter(target) {
  const cached = eventlessProxies.get(target)
  if (cached) return cached
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (isReflectedEmitterMethod(prop)) {
        return () => {
          throw reflectedEmitterError(/** @type {string} */ (prop))
        }
      }
      const value = Reflect.get(t, prop, receiver)
      // rpc-reflector represents methods and namespaces as callable proxies
      return typeof value === 'function'
        ? withoutReflectedEmitter(value)
        : value
    },
    apply(t, thisArg, args) {
      return Reflect.apply(/** @type {any} */ (t), thisArg, args)
    },
  })
  eventlessProxies.set(target, proxy)
  return proxy
}
