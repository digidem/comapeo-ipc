# @comapeo/ipc

IPC wrappers for [CoMapeo Core](https://github.com/digidem/comapeo-core). Meant to be used in contexts where there is a communication boundary between the contexts your code runs in e.g. Electron, React Native (with NodeJS Mobile), and NodeJS worker threads. The [channel messaging API](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API) is an example where this usage applies.

## Table of Contents

- [Installation](#installation)
- [API](#api)
- [Behaviour](#behaviour)
- [Errors](#errors)
- [Usage](#usage)
- [License](#license)

## Installation

Note that [`@comapeo/core`](https://github.com/digidem/comapeo-core) is a peer dependency, so you may have to install it manually depending on your package manager.

```sh
npm install @comapeo/ipc @comapeo/core
```

## API

### `createComapeoCoreServer(manager: MapeoManager, messagePort: MessagePortLike): { close: () => void }`

Creates the IPC server instance. `manager` is a `@comapeo/core` `MapeoManager` instance and `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort).

Returns an object with a `close()` method, which removes relevant event listeners from the `messagePort`. Does not close or destroy the `messagePort`.

### `createComapeoCoreClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ClientApi<MapeoManager>`

Creates the IPC client instance. `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort). `opts.timeout` is an optional timeout used for sending and receiving messages over the channel.

Returns a client instance that reflects the interface of the `manager` provided to [`createComapeoCoreServer`](#createcomapeocoreservermanager-mapeomanager-messageport-messageportlike--close---void). Refer to the [`rpc-reflector` docs](https://github.com/digidem/rpc-reflector#const-clientapi--createclientchannel) for additional information about how to use this.

### `closeComapeoCoreClient(client: ClientApi<MapeoManager>): Promise<void>`

Closes the IPC client instance. Does not close or destroy the `messagePort` provided to [`createComapeoCoreClient`](#createcomapeocoreclientmessageport-messageportlike-opts--timeout-number--clientapimapeomanager).

Some application services live outside `@comapeo/core` (for example the map server URL). They have their own client/server pair, which can share the same `messagePort` as the core client/server (see [Behaviour](#behaviour)).

### `createComapeoServicesServer(services: ComapeoServicesApi, messagePort: MessagePortLike): { close: () => void }`

Creates the services server. `services` implements the services API (currently `{ mapServer: { getBaseUrl(): Promise<string> } }`; the blob and icon servers will join it once extracted from core). Returns an object with a `close()` method; like `createComapeoCoreServer` it does not close the `messagePort`.

### `createComapeoServicesClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ClientApi<ComapeoServicesApi>`

Creates the services client, reflecting the `services` object passed to [`createComapeoServicesServer`](#createcomapeoservicesserverservices-comapeoservicesapi-messageport-messageportlike--close---void).

### `closeComapeoServicesClient(servicesClient: ClientApi<ComapeoServicesApi>): void`

Closes the services client. Does not close or destroy the `messagePort`.

### `notifyTransportReset(client): void`

Tell a client (core or services) that its transport to the server has dropped: every in-flight call rejects immediately with [`RpcChannelClosedError`](#errors) instead of waiting out its timeout. The client remains fully usable. See [Transport reset](#transport-reset).

### `resubscribe(client): void`

Re-send a client's (core or services) event subscriptions to the server, once the transport to a restarted server is connected again. See [Transport reset](#transport-reset).

## Behaviour

These are the guarantees the wrappers add on top of [`rpc-reflector`](https://github.com/digidem/rpc-reflector); they are exercised by the test suite.

### One port, many channels

A single `messagePort` multiplexes several independent RPC channels: the core (manager) API, an internal project-routing channel used to open projects, one channel per open project, and the services API. Every id this library mints carries a shared `@@comapeo/` prefix and messages are namespaced per channel, so:

- `createComapeoCoreServer` and `createComapeoServicesServer` can run over the same `messagePort` (paired with `createComapeoCoreClient` and `createComapeoServicesClient` on the other end) without interfering with each other.
- Closing one server or client does not disturb the others sharing the port.
- Traffic from a foreign sender sharing the port (any id without the `@@comapeo/` prefix) is ignored.

The wrappers never close or destroy the `messagePort` itself — that is the caller's responsibility.

### Calls and concurrency

- Every method call returns a `Promise` that resolves with the return value, or rejects with the error thrown on the server. Errors are reconstructed across the channel, preserving their `code`.
- Any number of calls may be in flight at once; each is matched to its response independently.
- Arguments and return values must be serializable by your transport (for example, the [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) for a `MessageChannel` or worker thread).
- A call rejects with [`RpcTimeoutError`](#errors) if no response arrives within `opts.timeout`.

### Projects

`client.getProject(id)` resolves with a client that reflects the `MapeoProject` API, including nested namespaces such as `project.observation.*`.

- **Deduplicated.** Concurrent or repeated `getProject(id)` calls resolve to the same reference — project references are permanent for the lifetime of the client. The id is validated with the server (and the project eagerly opened) only on **first acquisition**; after one success the cached wrapper is returned with no wire round trip.
- **Missing projects.** If the project does not exist, `getProject(id)` rejects with `NotFoundError` (from `@comapeo/core`). A failed lookup is not cached, so a later call for an id that does exist still succeeds.
- **Left projects.** If this device has left the project (`manager.leaveProject`), every method call on a held reference rejects with [`ProjectLeftError`](#errors) until the project is re-joined via an invite, after which the same reference works again. `getProject(id)` rejects the same way on first acquisition; for a project acquired before leaving it still resolves with the cached wrapper (whose calls then reject).

### Lifecycle

Project instance lifecycle is owned entirely by the server. The client cannot close a project (the reflected surface has no `project.close()`), and a project reference never goes stale.

The server delegates the lifecycle mechanics to rpc-reflector's late-bound handlers: each project channel has one long-lived rpc-reflector server whose handler — the live `MapeoProject` instance — is bound lazily by a factory when the first call or subscription arrives, and detached when the instance closes. rpc-reflector keeps event subscriptions in a registry that outlives the instance and re-attaches them to each fresh instance before any waiting call is dispatched. Concretely:

- The server may close a project instance at any time (resource management, `addProject` re-joining a previously-left project, a server restart). The next call on that project's channel transparently re-opens it — callers never observe the cycle.
- Event subscriptions survive server-side close/re-open, and subscribing to a project whose instance is closed re-opens it — a consumer that only listens still receives events.
- The one exception is a left project, which is never re-opened — see [`ProjectLeftError`](#errors).
- A `leaveProject` call routed through this server also closes the stale instance `@comapeo/core` leaves cached after leaving (core only cleans that up itself inside `addProject`). This hook and the server's left-project guard are an interim pair, removed together once core ships a typed PROJECT_LEFT error ([digidem/comapeo-core#1313](https://github.com/digidem/comapeo-core/issues/1313)).
- `closeComapeoCoreClient(client)` tears down the manager, the project-routing channel, and every project reference. After this, all calls — including `getProject(id)` — reject with [`ClientClosedError`](#errors). (The services client is independent; close it separately with [`closeComapeoServicesClient`](#closecomapeoservicesclientservicesclient-clientapicomapeoservicesapi-void).)
- Calls already in flight when the client closes reject with [`RpcChannelClosedError`](#errors); they are not re-routed.

### Transport reset

When the process hosting the server dies and restarts while the client stays alive (e.g. Android's foreground service being killed), the transport owner should drive a two-phase recovery:

- At drop time, call `notifyTransportReset(client)` (on the core client and, if used, the services client): every in-flight call rejects immediately with [`RpcChannelClosedError`](#errors) (`code: 'RPC_CHANNEL_CLOSED'`) instead of waiting out its timeout. Reads are safe to retry once the transport reconnects; whether to replay a mutation is the caller's judgement — nothing is replayed automatically.
- Once the transport is connected to the restarted server, call `resubscribe(client)` (on the same clients): every event subscription — manager and per-project — is re-sent, since the fresh server has no subscription state. Resubscription is deliberately not done at drop time: ON frames written into a down transport can keep nudging it into reconnect attempts while the server stays down.

Project references need no recovery: their channels are keyed by project id, which a restarted server serves identically — the next call (or a replayed subscription) transparently re-opens the project. Both functions are safe to call repeatedly and are no-ops after the client is closed.

### Events

The client reflects the `EventEmitter` interface of the manager and of each project. `client.on(event, listener)` forwards events emitted on the server across the channel; `removeListener` / `off` stop the forwarding. After a reference is closed these emitter methods behave differently — see [Errors](#errors).

## Errors

Error classes are available from the `@comapeo/ipc/errors.js` entrypoint:

```ts
import {
  ProjectLeftError,
  ClientClosedError,
  RpcChannelClosedError,
  RpcTimeoutError,
} from '@comapeo/ipc/errors.js'
```

- **`ProjectLeftError`** (`code: 'PROJECT_LEFT'`) — a method (including nested namespaces such as `project.observation.*`) or `getProject(id)` was called for a project this device has left. Left projects are never transparently re-opened; re-joining via an invite makes the same reference usable again.
- **`ClientClosedError`** (`code: 'CLIENT_CLOSED'`) — a method was called on the CoMapeo client, or on any project reference, after the whole client was torn down with [`closeComapeoCoreClient`](#closecomapeocoreclientclient-clientapimapeomanager-promisevoid). This includes `getProject(id)`, which after close rejects with `ClientClosedError` rather than returning a reference — whether or not that project was fetched earlier.

RPC methods return a rejected `Promise` carrying the error, so failures surface through normal `await`/`.catch()` handling. The exception is the event-emitter methods, which return synchronously rather than a promise — after the client is closed, subscribe methods (`on`, `once`, `addListener`, and `emit`/introspection) **throw** `ClientClosedError` synchronously so the failure surfaces at the call site rather than as an unhandled rejection, while unsubscribe methods (`off`, `removeListener`, `removeAllListeners`) are safe no-ops — removing a listener from a dead client is correct teardown.

Calls that were already in flight when the close happened are not re-routed: they reject with **`RpcChannelClosedError`** (`code: 'RPC_CHANNEL_CLOSED'`) as the underlying channel tears down. The same error rejects in-flight calls when [`notifyTransportReset`](#transport-reset) is called. `RpcTimeoutError` is thrown when a call exceeds the `opts.timeout` passed to [`createComapeoCoreClient`](#createcomapeocoreclientmessageport-messageportlike-opts--timeout-number--clientapimapeomanager).

## Usage

In the server:

```ts
import { MapeoManager } from '@comapeo/core'
import { createComapeoCoreServer } from '@comapeo/ipc'

// Create CoMapeo Core manager instance
const manager = new MapeoManager({...})

// Create the server instance
// `messagePort` can vary based on context (e.g. a port from a MessageChannel, a NodeJS Mobile bridge channel, etc.)
const server = createComapeoCoreServer(manager, messagePort)

// Maybe at some point later on...

// Close the server
server.close()
```

In the client:

```ts
import { createComapeoCoreClient, closeComapeoCoreClient } from '@comapeo/ipc'

// Create the client instance
// `messagePort` can vary based on context (e.g. a port from a MessageChannel, a NodeJS Mobile bridge channel, etc.)
const client = createComapeoCoreClient(messagePort)

// Use the MapeoManager instance from the server via the client!
const projectId = await client.createProject({...})
const project = await client.getProject(projectId)
const projects = await client.listProjects()

client.on('local-peers', (peers) => {
  // ...
})

// Maybe at some point later on...

// Close the client
closeComapeoCoreClient(client)
```

## License

[MIT](LICENSE)
