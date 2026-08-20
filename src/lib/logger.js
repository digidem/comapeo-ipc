/** @import { Logger } from 'rpc-reflector' */

/**
 * No-op logger used when logging is disabled. Same role as the
 * `abstract-logging` package rpc-reflector uses, inlined to avoid pulling in
 * an untyped dependency.
 * @type {Logger}
 */
const nullLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/**
 * Resolve the `logger` option into a usable logger. `false`/absent disables
 * logging (no-op logger).
 *
 * When `bindings` are given and the logger is pino-compatible (exposes
 * `child`), a child logger carrying those bindings is returned. We use
 * structured bindings rather than pino's `msgPrefix` so the library doesn't
 * rewrite the message text of a logger it doesn't own: bindings merge as
 * fields, a parent app's existing bindings survive, and there's no prefix
 * stacking if a layer below ever adds its own. Loggers without `child` (e.g.
 * the global `console`) are returned unchanged.
 *
 * @param {false | Logger} [logger]
 * @param {Record<string, string>} [bindings]
 * @returns {Logger}
 */
export function createLogger(logger, bindings) {
  if (!logger) return nullLogger
  if (!bindings) return logger
  const child =
    /** @type {{ child?: (bindings: Record<string, string>) => Logger }} */ (
      logger
    ).child
  if (typeof child === 'function') {
    return child.call(logger, bindings)
  }
  return logger
}
