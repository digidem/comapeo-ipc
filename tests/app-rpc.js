import test from 'node:test'
import assert from 'node:assert/strict'

import { createAppRpcClient, closeAppRpcClient } from '../src/client.js'
import { createAppRpcServer } from '../src/server.js'

/**
 * Wire up a server and client over a fresh channel for an app-defined api. The
 * app RPC channel is generic: the consuming app decides the shape of the api,
 * so the tests below exercise both flat and nested shapes.
 *
 * @template {Record<string, any>} T
 * @param {import('node:test').TestContext} t
 * @param {T} api
 */
function setup(t, api) {
  const { port1, port2 } = new MessageChannel()

  const server = createAppRpcServer(api, port1)
  const client = /** @type {import('../src/client.js').AppRpcClientApi<T>} */ (
    createAppRpcClient(port2)
  )

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

function createFlatApi() {
  return {
    async ping() {
      return 'pong'
    },
    /**
     * @param {number} a
     * @param {number} b
     */
    async add(a, b) {
      return a + b
    },
  }
}

function createNestedApi() {
  return {
    mapServer: {
      /** @param {{ localPort?: number }} [options] */
      async listen(options) {
        return { localPort: options?.localPort || 3000, remotePort: 3001 }
      },
      async close() {},
    },
    blobServer: {
      /** @param {string} blobId */
      async getUrl(blobId) {
        return `http://localhost:3002/${blobId}`
      },
    },
  }
}

test('AppRpc relays calls to a flat app-defined api', async (t) => {
  const { client } = setup(t, createFlatApi())

  assert.equal(await client.ping(), 'pong')
  assert.equal(await client.add(2, 3), 5)
})

test('AppRpc relays calls to a nested app-defined api', async (t) => {
  const { client } = setup(t, createNestedApi())

  const listenResult = await client.mapServer.listen({ localPort: 4000 })
  assert.equal(listenResult.localPort, 4000)
  assert.equal(listenResult.remotePort, 3001)

  assert.equal(
    await client.blobServer.getUrl('abc'),
    'http://localhost:3002/abc',
  )

  await client.mapServer.close()
})

test('AppRpc resolves concurrent calls independently', async (t) => {
  let callCount = 0

  const { client } = setup(t, {
    /** @param {number} n */
    async double(n) {
      callCount++
      return n * 2
    },
  })

  const results = await Promise.all([
    client.double(1),
    client.double(2),
    client.double(3),
  ])

  assert.equal(callCount, 3)
  assert.deepEqual(results, [2, 4, 6])
})

test('AppRpc propagates server method errors to the client', async (t) => {
  const { client } = setup(t, {
    async fail() {
      throw new Error('boom')
    },
  })

  await assert.rejects(() => client.fail(), { message: 'boom' })
})

test('AppRpc client calls fail after the server closes', async (t) => {
  const api = createFlatApi()
  const { client, server } = setup(t, api)

  // Works before closing.
  assert.equal(await client.ping(), 'pong')

  server.close()
  closeAppRpcClient(client)

  await assert.rejects(() => client.ping())
})

test('AppRpc server close is idempotent', (t) => {
  const { server } = setup(t, createFlatApi())

  // Closing more than once must not throw; t.after closes again too.
  server.close()
  server.close()
})

test('AppRpc isolates independent clients on separate channels', async (t) => {
  const { client: client1 } = setup(t, {
    async whoami() {
      return 'one'
    },
  })
  const { client: client2 } = setup(t, {
    async whoami() {
      return 'two'
    },
  })

  const [result1, result2] = await Promise.all([
    client1.whoami(),
    client2.whoami(),
  ])

  assert.equal(result1, 'one')
  assert.equal(result2, 'two')
})
