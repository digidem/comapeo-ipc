# AGENTS.md — @comapeo/ipc

## What this is

IPC wrappers for [CoMapeo Core](https://github.com/digidem/comapeo-core). They bridge the `MapeoManager` API (and a small services API) across a communication boundary using [rpc-reflector](https://github.com/digidem/rpc-reflector) over a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort)-like object. Target contexts: Electron, React Native (NodeJS Mobile), and Node worker threads — anywhere the [Channel Messaging API](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API) or an equivalent port applies.

One `messagePort` multiplexes several independent channels (manager, project-routing, one per open project, a server→client events channel, and the services API). See the README's **Behaviour** section for the full contract.

## Language & Runtime

- **Plain JavaScript (ESM)** — no TypeScript source, no build step for dev. Types are expressed via **JSDoc**, checked by `tsc --noEmit` (strict, `allowJs`/`checkJs`).
- **Node ≥ 24** (`engines`); local dev is pinned to **Node 24** (`.nvmrc` / `.tool-versions`). CI tests against 24.
- **Build** (`tsc -p tsconfig.npm.json`) only emits `dist/` (JS + `.d.ts`) for publishing — run via `prepack`, not during dev. `dist/` is the `files` field; it is not committed.

## Commands

| Task              | Command                                                |
| ----------------- | ------------------------------------------------------ |
| Run tests         | `npm test` (runs `node --expose-gc --test tests/*.js`) |
| Run a single test | `node --test tests/basic.js`                           |
| All checks (CI)   | `npm run check` (parallel: eslint + prettier + tsc)    |
| Lint only         | `npm run check:eslint`                                 |
| Format check      | `npm run check:format`                                 |
| Type check        | `npm run check:types`                                  |
| Build for publish | `npm run build` (tsc → `dist/`)                        |

A **pre-commit hook** (husky) runs `lint-staged` → `prettier --write` on staged files (skipped when `CI` is set).

## Project Structure

```
src/
  index.js        Public API re-exports + shared typedefs (entrypoint)
  client.js       createComapeoCoreClient / closeComapeoCoreClient /
                  getComapeoCoreClientEvents + services client
  server.js       createComapeoCoreServer / createComapeoServicesServer
  errors.js       ClientClosedError; re-exports Rpc* errors from rpc-reflector
  lib/
    sub-channel.js      Channel-id constants (@@comapeo/ prefix) + SubChannel
    events.js           Event-name lists + encode/decode event frames
    reflected-emitter.js Strip reflected EventEmitter methods (temporary, see note)
    utils.js            isRelevantEventData guard
tests/
  *.js              node:test suites (basic, events, multiplexing, services,
                    timeout, transport, project-close, integration, ...)
  helpers.js        setup(t, manager) — wires server+client over a MessageChannel
  fake-manager.js   FakeManager — stand-in for MapeoManager in tests
```

## Key Conventions

### Client / Server API

- Every public method is documented in the README **API** section — keep it in sync when changing signatures.
- `createComapeoCoreClient` / `createComapeoServicesClient` accept an optional `{ timeout }` used for send/receive over the channel.
- Servers return `{ close() }`; **neither `close()` nor any client close tears down the `messagePort`** — that is the caller's job.
- Project references are cached for the life of the client and never invalidated: a closed/re-opened project is transparently re-opened on the server at the next call.

### Channels & ids

- All ids minted by this library carry the `@@comapeo/` prefix (`COMAPEO_PREFIX`). Traffic from a foreign sender sharing the port (no prefix) is ignored. Don't add un-prefixed channel ids.

### Events

- Core event lists live in `src/lib/events.js` (`MANAGER_EVENTS`, `INVITE_EVENTS`, `PROJECT_EVENTS`, `SYNC_EVENTS`), each typed via `@satisfies` against the corresponding core emitter. **Adding a new core event requires updating the relevant list AND the `ComapeoCoreClientEvents` typedef** — they are checked against core's emitter types.
- Project events are prefixed `project:` and receive the project public id as the first listener argument (one channel carries every project's events).
- Events are delivered only through `getComapeoCoreClientEvents(client)` (an `eventemitter3` instance). Reflected objects do **not** expose `EventEmitter` methods — `src/lib/reflected-emitter.js` strips them so calling `on`/`off`/etc. on a client/project proxy throws a `TypeError`.

### Errors

- Error classes come from the `@comapeo/ipc/errors.js` entrypoint: `ClientClosedError` (`CLIENT_CLOSED`), plus re-exported `RpcChannelClosedError` and `RpcTimeoutError` from rpc-reflector. Preserve the `code` field across the channel.

## Code Style

- Prettier: **no semicolons, single quotes** (`prettier.config.js`). Prettier is the formatter — don't hand-fight it.
- `import`/`export` (ESM) only. `verbatimModuleSyntax` is on: type-only imports must use `import type` / the `/** @import */` JSDoc form.
- JSDoc on exported functions. Types are shared via `@typedef` / `@import` (see `src/index.js`).
- `noUncheckedIndexedAccess` + `noImplicitAny` are on — guard index access and type callback params.

## Testing

- Built-in `node:test` + `node:assert`. No mocking framework.
- `tests/helpers.js` `setup(t, manager)` builds a real server+client over a `new MessageChannel()` and registers teardown via `t.after()`. Use `FakeManager` (`tests/fake-manager.js`) as the manager stand-in unless you need real core behaviour.
- The **Behaviour** guarantees in the README are deliberately exercised by the suite — when you change lifecycle/multiplexing/event semantics, add or update the matching test.
- `--expose-gc` is passed so tests can force GC where needed.

## Gotchas

- **No dev build step.** Edit `.js` in `src/`, run `tsc` (via `npm run check:types`) and `npm test`. `dist/` is publish-only.
- The server's per-project handler is a **Proxy that dispatches against the _current live_ `MapeoProject`** (re-resolved on every call / re-validation) — not the instance captured at open time. Preserve this when touching `src/server.js`.
- `src/lib/reflected-emitter.js` is explicitly **temporary**: it exists only until rpc-reflector stops reflecting `EventEmitter` methods onto client proxies. Don't build on it as a permanent abstraction.
- Closing the server does **not** notify the client; calls made while the server is closed reject with `RpcTimeoutError` after `timeout`.

## Commit Messages

Conventional Commits style (`type: summary`), enforced for changelog generation. One short line, no trailing period. Name the thing being changed. No "WIP"/"update" prefixes — commit in logical units.

## Keeping AGENTS.md Current

Update this file whenever a change would cause a _new_ agent (or a future-you with amnesia) to do something wrong or waste time: a new source module, a changed public API contract, a changed build/test/lint command, a new external dep that affects the dev workflow, a convention established or retired, or a discovered gotcha. The test: _"Would an agent reading only this file make a mistake or get confused?"_ If yes, update it. Don't update for internal refactors, plain bug fixes, or content changes within existing files.
