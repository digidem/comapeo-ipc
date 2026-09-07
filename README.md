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

- **Deduplicated.** Concurrent or repeated `getProject(id)` calls resolve to the same reference and open the project only once on the server.
- **Persistent reference.** The reference is cached for the life of the client and never discarded. A project that is closed and re-opened is transparently re-opened on the server at the next call, so the _same_ reference you already hold keeps working — there is no stale reference to throw away.
- **Missing projects.** If the project does not exist, `getProject(id)` rejects with `NotFoundError` (from `@comapeo/core`). A failed lookup is not cached, so a later call for an id that does exist still succeeds.
- **Isolation.** Closing one project does not affect other open projects.

### Lifecycle

- `project.close()` closes the project on the server. It does **not** tear down the client's channel or invalidate the reference — the same reference stays usable. It is idempotent — repeated calls resolve like the first.
- A project can be closed from the client (`project.close()`) **or** by the server (for example `leaveProject`). After it is closed, the next method call on the reference transparently re-opens the project on the server and proceeds against the fresh instance.
- `closeComapeoCoreClient(client)` tears down the manager, the project-routing channel, and every project channel. After this, `getProject(id)` and all manager methods reject with [`ClientClosedError`](#errors), and calls on a previously-obtained project reference reject with [`RpcChannelClosedError`](#errors) as its channel is torn down. (The services client is independent; close it separately with [`closeComapeoServicesClient`](#closecomapeoservicesclientservicesclient-clientapicomapeoservicesapi-void).)
- Calls already in flight when the client is closed reject with [`RpcChannelClosedError`](#errors); they are not re-routed.

### Events

The client reflects the `EventEmitter` interface of the manager and of each project. `client.on(event, listener)` forwards events emitted on the server across the channel; `removeListener` / `off` stop the forwarding.

Project events are only forwarded while the project is open. Because a closed project is re-opened as a _new_ underlying instance, an existing subscription does not automatically carry over. If you need an event after a project has been closed and re-opened, **re-subscribe** — a common pattern is to listen for the project's `close` event, then call `client.on(...)` again (typically right after a fresh `client.getProject(id)`).

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

- **`ClientClosedError`** (`code: 'CLIENT_CLOSED'`) — a method was called on the CoMapeo client, or `getProject(id)` was called, after the whole client was torn down with [`closeComapeoCoreClient`](#closecomapeocoreclientclient-clientapimapeomanager-promisevoid). Whether or not that project was fetched earlier, `getProject(id)` after close rejects with `ClientClosedError` rather than returning a reference.

`ClientClosedError` is raised on the manager reference: RPC methods return a rejected `Promise` carrying it, and the event-emitter methods (`on`, `once`, `off`, `removeListener`, etc.) — which return synchronously rather than a promise — **throw** it synchronously at the call site instead, so it surfaces there rather than as an unhandled rejection.

Calls on a previously-obtained project reference (and any calls already in flight) when the client is closed are not re-routed: they reject with **`RpcChannelClosedError`** as the project's channel tears down. `RpcTimeoutError` is thrown when a call exceeds the `opts.timeout` passed to [`createComapeoCoreClient`](#createcomapeocoreclientmessageport-messageportlike-opts--timeout-number--clientapimapeomanager).

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
