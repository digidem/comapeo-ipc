# @comapeo/ipc

IPC wrappers for [CoMapeo Core](https://github.com/digidem/comapeo-core). Meant to be used in contexts where there is a communication boundary between the contexts your code runs in e.g. Electron, React Native (with NodeJS Mobile), and NodeJS worker threads. The [channel messaging API](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API) is an example where this usage applies.

## Table of Contents

- [Installation](#installation)
- [API](#api)
- [Errors](#errors)
- [Usage](#usage)
- [License](#license)

## Installation

Note that [`@comapeo/core`](https://github.com/digidem/comapeo-core) is a peer dependency, so you may have to install it manually depending on your package manager.

```sh
npm install @comapeo/ipc @comapeo/core
```

## API

### `createMapeoServer(manager: MapeoManager, messagePort: MessagePortLike): { close: () => void }`

Creates the IPC server instance. `manager` is a `@comapeo/core` `MapeoManager` instance and `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort).

Returns an object with a `close()` method, which removes relevant event listeners from the `messagePort`. Does not close or destroy the `messagePort`.

### `createMapeoClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ClientApi<MapeoManager>`

Creates the IPC client instance. `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort). `opts.timeout` is an optional timeout used for sending and receiving messages over the channel.

Returns a client instance that reflects the interface of the `manager` provided to [`createMapeoServer`](#createmapeoservermanager-mapeomanager-messageport-messageportlike--close---void). Refer to the [`rpc-reflector` docs](https://github.com/digidem/rpc-reflector#const-clientapi--createclientchannel) for additional information about how to use this.

### `closeMapeoClient(mapeoClient: ClientApi<MapeoManager>): void`

Closes the IPC client instance. Does not close or destroy the `messagePort` provided to [`createMapeoClient`](#createmapeoclientmessageport-messageportlike-clientapimapeomanager).

## Errors

Error classes are available from the `@comapeo/ipc/errors.js` entrypoint:

```ts
import {
  ProjectClosedError,
  ManagerClosedError,
  RpcChannelClosedError,
  RpcTimeoutError,
} from '@comapeo/ipc/errors.js'
```

After a reference is closed, calls made on it reject with a descriptive error:

- **`ProjectClosedError`** (`code: 'PROJECT_CLOSED'`) — a method (including nested namespaces such as `project.observation.*`) was called on a project reference after that project was closed, either via `await project.close()` or by the server closing the project. A re-opened reference from a fresh `client.getProject(id)` is unaffected.
- **`ClientClosedError`** (`code: 'CLIENT_CLOSED'`) — a method was called on the CoMapeo client, or on any project reference, after the whole client was torn down with [`closeMapeoClient`](#closemapeoclientmapeoclient-clientapimapeomanager-void).

RPC methods return a rejected `Promise` carrying the error, so failures surface through normal `await`/`.catch()` handling. The exception is the event-emitter methods (`on`, `once`, `off`, `removeListener`, `emit`, etc.), which return synchronously rather than a promise — after close these **throw** the same error synchronously instead, so it surfaces at the call site rather than as an unhandled rejection.

Calls that were already in flight when the close happened are not re-routed: they reject with **`RpcChannelClosedError`** as the underlying channel tears down. `RpcTimeoutError` is thrown when a call exceeds the `opts.timeout` passed to [`createMapeoClient`](#createmapeoclientmessageport-messageportlike-clientapimapeomanager).

## Usage

In the server:

```ts
import { MapeoManager } from '@comapeo/core'
import { createMapeoServer } from '@comapeo/ipc'

// Create Mapeo manager instance
const manager = new MapeoManager({...})

// Create the server instance
// `messagePort` can vary based on context (e.g. a port from a MessageChannel, a NodeJS Mobile bridge channel, etc.)
const server = createMapeoServer(manager, messagePort)

// Maybe at some point later on...

// Close the server
server.close()
```

In the client:

```ts
import { createMapeoClient, closeMapeoClient } from '@comapeo/ipc'

// Create the client instance
// `messagePort` can vary based on context (e.g. a port from a MessageChannel, a NodeJS Mobile bridge channel, etc.)
const client = createMapeoClient(messagePort)

// Use the MapeoManager instance from the server via the client!
const projectId = await client.createProject({...})
const project = await client.getProject(projectId)
const projects = await client.listProjects()

client.on('invite-received', (invite) => {
  // ...
})

// Maybe at some point later on...

// Close the client
closeMapeoClient(client)
```

## License

[MIT](LICENSE)
