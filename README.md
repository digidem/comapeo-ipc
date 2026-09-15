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

### `createComapeoCoreClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ComapeoCoreClientApi`

Creates the IPC client instance. `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort). `opts.timeout` is an optional timeout used for sending and receiving messages over the channel.

Returns a client instance that reflects the methods of the `manager` provided to [`createComapeoCoreServer`](#createcomapeocoreservermanager-mapeomanager-messageport-messageportlike--close---void). Refer to the [`rpc-reflector` docs](https://github.com/digidem/rpc-reflector#const-clientapi--createclientchannel) for additional information about how to use this. Server events are delivered through [`getComapeoCoreClientEvents`](#getcomapeocoreclienteventsclient-comapeocoreclientapi-comapeocoreclientemitter), not through reflected `EventEmitter` methods.

### `closeComapeoCoreClient(client: ComapeoCoreClientApi): Promise<void>`

Closes the IPC client instance. Does not close or destroy the `messagePort` provided to [`createComapeoCoreClient`](#createcomapeocoreclientmessageport-messageportlike-opts--timeout-number--comapeocoreclientapi).

### `getComapeoCoreClientEvents(client: ComapeoCoreClientApi): ComapeoCoreClientEmitter`

Returns the emitter that delivers server events to the client (see [Events](#events)).

Some application services live outside `@comapeo/core` (for example the map server URL). They have their own client/server pair, which can share the same `messagePort` as the core client/server (see [Behaviour](#behaviour)).

### `createComapeoServicesServer(services: ComapeoServicesApi, messagePort: MessagePortLike): { close: () => void }`

Creates the services server. `services` implements the services API (currently `{ mapServer: { getBaseUrl(): Promise<string> } }`; the blob and icon servers will join it once extracted from core). Returns an object with a `close()` method; like `createComapeoCoreServer` it does not close the `messagePort`.

### `createComapeoServicesClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ClientApi<ComapeoServicesApi>`

Creates the services client, reflecting the `services` object passed to [`createComapeoServicesServer`](#createcomapeoservicesserverservices-comapeoservicesapi-messageport-messageportlike--close---void).

### `closeComapeoServicesClient(servicesClient: ClientApi<ComapeoServicesApi>): void`

Closes the services client. Does not close or destroy the `messagePort`.

## Behaviour

These are the guarantees the wrappers add on top of [`rpc-reflector`](https://github.com/digidem/rpc-reflector); they are exercised by the test suite.

### One port, many channels

A single `messagePort` multiplexes several independent channels: the core (manager) API, an internal project-routing channel used to open projects, one channel per open project, a server-to-client events channel, and the services API. Every id this library mints carries a shared `@@comapeo/` prefix and messages are namespaced per channel, so:

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

- **Deduplicated.** Concurrent or repeated `getProject(id)` calls resolve to the same reference and open the project only once on the server.
- **Persistent reference.** The reference is cached for the life of the client and never discarded. A project that is closed and re-opened is transparently re-opened on the server at the next call, so the _same_ reference you already hold keeps working — there is no stale reference to throw away.
- **Missing projects.** If the project does not exist, `getProject(id)` rejects with `NotFoundError` (from `@comapeo/core`). A failed lookup is not cached, so a later call for an id that does exist still succeeds.
- **Isolation.** Closing one project does not affect other open projects.

### Lifecycle

- `project.close()` closes the project on the server. It does **not** tear down the client's channel or invalidate the reference — the same reference stays usable. It is idempotent — repeated calls resolve like the first.
- A project can be closed from the client (`project.close()`) **or** by the server (for example `leaveProject`). After it is closed, the next method call on the reference transparently re-opens the project on the server and proceeds against the fresh instance. Event delivery follows the live instance (see [Events](#events)).
- `closeComapeoCoreClient(client)` tears down the manager, the project-routing channel, and every project channel. After this, `getProject(id)` and all manager methods reject with [`ClientClosedError`](#errors), and calls on a previously-obtained project reference reject with [`RpcChannelClosedError`](#errors) as its channel is torn down. (The services client is independent; close it separately with [`closeComapeoServicesClient`](#closecomapeoservicesclientservicesclient-clientapicomapeoservicesapi-void).)
- Calls already in flight when the client is closed reject with [`RpcChannelClosedError`](#errors); they are not re-routed.
- Closing the server does not notify the client. Calls made while the server is closed reject with [`RpcTimeoutError`](#errors) after `opts.timeout`.

### Events

`getComapeoCoreClientEvents(client)` returns an [`eventemitter3`](https://github.com/primus/eventemitter3) instance typed with the `ComapeoCoreClientEvents` event map:

| Event                     | Listener arguments         |
| ------------------------- | -------------------------- |
| `local-peers`             | `(peers)`                  |
| `map-share`               | `(mapShare)`               |
| `map-share-error`         | `(error, mapShare)`        |
| `invite-received`         | `(invite)`                 |
| `invite-updated`          | `(invite)`                 |
| `project:own-role-change` | `(projectId, changeEvent)` |
| `project:sync-state`      | `(projectId, state)`       |

Manager and invite events keep their core names and arguments. Project events are prefixed with `project:` and receive the project's public id first, because one channel carries the events of every project. An `Error` argument (as in `map-share-error`) arrives as an `Error`.

```ts
const events = getComapeoCoreClientEvents(client)
events.on('local-peers', (peers) => {
  // ...
})
events.on('project:sync-state', (projectId, state) => {
  // ...
})
```

The server broadcasts every event it relays on a dedicated channel and keeps no subscription state; subscriptions exist only in the client emitter. This means:

- **No re-subscribing.** Events for a project come from whichever `MapeoProject` instance is live on the server. When a project is closed and re-opened, events from the new instance reach the same listeners.
- **No gap between subscribing and fetching.** Events and method responses share the ordered port, so an event emitted while a call is handled arrives before that call's response. Subscribe first, then call a getter: the value it returns already includes every event delivered before it, and later events arrive after it.
- **Events flow once the client has used the project.** The relay attaches when `getProject(id)` resolves and moves on the next call that finds a different live instance. If the server re-opens a project on its own (for example when core re-joins it), its events resume after the client's next method call on that project; events emitted before that call are lost.

The reflected objects (`client`, `client.invite`, a project, `project.$sync`, `project.observation`, ...) do not expose `EventEmitter` methods: calling `on`, `off`, `addListener` or any other `EventEmitter` method on them throws a `TypeError` pointing at `getComapeoCoreClientEvents`, and the methods are absent from the client types.

## Errors

Error classes are available from the `@comapeo/ipc/errors.js` entrypoint:

```ts
import {
  ClientClosedError,
  RpcChannelClosedError,
  RpcTimeoutError,
} from '@comapeo/ipc/errors.js'
```

After the client is closed, calls made on it reject with a descriptive error:

- **`ClientClosedError`** (`code: 'CLIENT_CLOSED'`) — a method was called on the CoMapeo client, or `getProject(id)` was called, after the whole client was torn down with [`closeComapeoCoreClient`](#closecomapeocoreclientclient-comapeocoreclientapi-promisevoid). Whether or not that project was fetched earlier, `getProject(id)` after close rejects with `ClientClosedError` rather than returning a reference.

`ClientClosedError` is raised on the manager reference: RPC methods return a rejected `Promise` carrying it. The client emitter keeps working locally after close (listeners can still be added and removed) but receives no further events.

After the client is closed, calls on a previously-obtained project reference, and any calls already in flight, reject with **`RpcChannelClosedError`** as the project's channel tears down. `RpcTimeoutError` is thrown when a call exceeds the `opts.timeout` passed to [`createComapeoCoreClient`](#createcomapeocoreclientmessageport-messageportlike-opts--timeout-number--comapeocoreclientapi).

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
import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
  getComapeoCoreClientEvents,
} from '@comapeo/ipc'

// Create the client instance
// `messagePort` can vary based on context (e.g. a port from a MessageChannel, a NodeJS Mobile bridge channel, etc.)
const client = createComapeoCoreClient(messagePort)

// Use the MapeoManager instance from the server via the client!
const projectId = await client.createProject({...})
const project = await client.getProject(projectId)
const projects = await client.listProjects()

const events = getComapeoCoreClientEvents(client)
events.on('local-peers', (peers) => {
  // ...
})
events.on('project:sync-state', (projectId, state) => {
  // ...
})

// Maybe at some point later on...

// Close the client
closeComapeoCoreClient(client)
```

## License

[MIT](LICENSE)
