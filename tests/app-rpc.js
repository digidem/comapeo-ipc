import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'

import { createAppRpcClient, closeAppRpcClient } from '../src/client.js'
import { createAppRpcServer } from '../src/server.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../src/server.js').RpcApi} [rpcApi]
 */
function setup(t, rpcApi) {
  const { port1, port2 } = new MessageChannel()

  const api = rpcApi || createMockRpcApi()
  const server = createAppRpcServer(api, port1)
  const client = createAppRpcClient(port2)

  port1.start()
  port2.start()

  t.after(() => {
    server.close()
    closeAppRpcClient(client)
    port1.close()
    port2.close()
  })

  return { server, client, api }
}

/** @returns {import('../src/server.js').RpcApi} */
function createMockRpcApi() {
  return {
    mapServer: {
      async listen(options) {
        const localPort = options?.localPort || 3000
        return { localPort, remotePort: 3001 }
      },
      async close() {},
    },
  }
}

test('AppRpc client can call server method and get result', async (t) => {
  const { client } = setup(t)

  const result = await client.mapServer.listen({ localPort: 4000 })

  assert.equal(result.localPort, 4000)
})

test('AppRpc client can call multiple methods', async (t) => {
  const { client } = setup(t)

  const listenResult = await client.mapServer.listen({ localPort: 5000 })
  assert.equal(listenResult.localPort, 5000)

  await client.mapServer.close()
})

test('AppRpc concurrent calls resolve correctly', async (t) => {
  let callCount = 0

  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async listen(options) {
        callCount++
        return { localPort: options?.localPort || 3000, remotePort: 3001 }
      },
      async close() {},
    },
  }

  const { client } = setup(t, api)

  const results = await Promise.all([
    client.mapServer.listen({ localPort: 4001 }),
    client.mapServer.listen({ localPort: 4002 }),
    client.mapServer.listen({ localPort: 4003 }),
  ])

  assert.equal(callCount, 3)
  assert.equal(results[0].localPort, 4001)
  assert.equal(results[1].localPort, 4002)
  assert.equal(results[2].localPort, 4003)
})

test('AppRpc server method errors are propagated to client', async (t) => {
  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async listen() {
        throw new Error('Address already in use')
      },
      async close() {},
    },
  }

  const { client } = setup(t, api)

  await assert.rejects(() => client.mapServer.listen({}), {
    message: 'Address already in use',
  })
})

test('AppRpc client calls fail after server closes', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const api = createMockRpcApi()
  const server = createAppRpcServer(api, port1)
  const client = createAppRpcClient(port2)

  port1.start()
  port2.start()

  // Verify it works first
  const result = await client.mapServer.listen({ localPort: 6000 })
  assert.equal(result.localPort, 6000)

  server.close()
  closeAppRpcClient(client)

  await assert.rejects(() => client.mapServer.listen({ localPort: 6001 }))

  t.after(() => {
    port1.close()
    port2.close()
  })
})

test('AppRpc works with nested object API', async (t) => {
  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async listen(options) {
        return { localPort: options?.localPort || 3000, remotePort: 3001 }
      },
      async close() {},
    },
  }

  const { client } = setup(t, api)

  const result = await client.mapServer.listen({ localPort: 7000 })
  assert.equal(result.localPort, 7000)
})

test('AppRpc server close is idempotent', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const api = createMockRpcApi()
  const server = createAppRpcServer(api, port1)
  const client = createAppRpcClient(port2)

  port1.start()
  port2.start()

  // Closing server multiple times should not throw
  server.close()
  server.close()

  closeAppRpcClient(client)

  t.after(() => {
    port1.close()
    port2.close()
  })
})

test('AppRpc multiple independent clients on separate channels', async (t) => {
  const { port1: serverPort1, port2: clientPort1 } = new MessageChannel()
  const { port1: serverPort2, port2: clientPort2 } = new MessageChannel()

  let callCount = 0
  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async listen(options) {
        callCount++
        return { localPort: options?.localPort || 3000, remotePort: 3001 }
      },
      async close() {},
    },
  }

  const server1 = createAppRpcServer(api, serverPort1)
  const server2 = createAppRpcServer(api, serverPort2)
  const client1 = createAppRpcClient(clientPort1)
  const client2 = createAppRpcClient(clientPort2)

  serverPort1.start()
  clientPort1.start()
  serverPort2.start()
  clientPort2.start()

  const [result1, result2] = await Promise.all([
    client1.mapServer.listen({ localPort: 8001 }),
    client2.mapServer.listen({ localPort: 8002 }),
  ])

  assert.equal(result1.localPort, 8001)
  assert.equal(result2.localPort, 8002)
  assert.equal(callCount, 2)

  t.after(() => {
    server1.close()
    server2.close()
    closeAppRpcClient(client1)
    closeAppRpcClient(client2)
    serverPort1.close()
    clientPort1.close()
    serverPort2.close()
    clientPort2.close()
  })
})
