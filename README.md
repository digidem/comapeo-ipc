# @mapeo/ipc

IPC wrappers for [Mapeo Core](https://github.com/digidem/mapeo-core-next). Meant to be used in contexts where there is a communication boundary between the contexts your code runs in e.g. Electron, React Native (with NodeJS Mobile), and NodeJS worker threads. The [channel messaging API](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API) is an example where this usage applies.

## Table of Contents

- [Installation](#installation)
- [API](#api)
- [Usage](#usage)
- [License](#license)

## Installation

Note that [`@mapeo/core`](https://github.com/digidem/mapeo-core-next) is a peer dependency, so you may have to install it manually depending on your package manager.

```sh
npm install @mapeo/ipc @mapeo/core
```

## API

### `createMapeoServer(manager: MapeoManager, messagePort: MessagePortLike): { close: () => void }`

Creates the IPC server instance. `manager` is a `@mapeo/core` `MapeoManager` instance and `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort).

Returns an object with a `close()` method, which removes relevant event listeners from the `messagePort`. Does not close or destroy the `messagePort`.

### `createMapeoClient(messagePort: MessagePortLike, opts?: { timeout?: number }): ClientApi<MapeoManager>`

Creates the IPC client instance. `messagePort` is an interface that resembles a [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort). `opts.timeout` is an optional timeout used for sending and receiving messages over the channel.

Returns a client instance that reflects the interface of the `manager` provided to [`createMapeoServer`](#createmapeoservermanager-mapeomanager-messageport-messageportlike--close---void). Refer to the [`rpc-reflector` docs](https://github.com/digidem/rpc-reflector#const-clientapi--createclientchannel) for additional information about how to use this.

### `closeMapeoClient(mapeoClient: ClientApi<MapeoManager>): void`

Closes the IPC client instance. Does not close or destroy the `messagePort` provided to [`createMapeoClient`](#createmapeoclientmessageport-messageportlike-clientapimapeomanager).

## Usage

In the server:

```ts
import { MapeoManager } from '@mapeo/core'
import { createMapeoServer } from '@mapeo/ipc'

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
import { createMapeoClient, closeMapeoClient } from '@mapeo/ipc'

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
