import test from 'node:test'
import assert from 'node:assert/strict'

import { createAppRpcClient, closeAppRpcClient } from '../src/client.js'
import { createAppRpcServer } from '../src/server.js'
import { RpcChannelClosedError } from '../src/errors.js'

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

const MOCK_BASE_URL = 'http://localhost:3000'

/** @returns {import('../src/server.js').RpcApi} */
function createMockRpcApi() {
  return {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }
}

test('AppRpc client can call server method and get result', async (t) => {
  const { client } = setup(t)

  const result = await client.mapServer.getBaseUrl()

  assert.equal(result, MOCK_BASE_URL)
})

test('AppRpc concurrent calls resolve correctly', async (t) => {
  let callCount = 0

  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async getBaseUrl() {
        callCount++
        return MOCK_BASE_URL + `-${callCount}`
      },
    },
  }

  const { client } = setup(t, api)

  const results = await Promise.all([
    client.mapServer.getBaseUrl(),
    client.mapServer.getBaseUrl(),
    client.mapServer.getBaseUrl(),
  ])

  assert.equal(callCount, 3)
  assert.equal(results[0], MOCK_BASE_URL + '-1')
  assert.equal(results[1], MOCK_BASE_URL + '-2')
  assert.equal(results[2], MOCK_BASE_URL + '-3')
})

test('AppRpc server method errors are propagated to client', async (t) => {
  const expectedError = new Error('Error')
  /** @type {import('../src/server.js').RpcApi} */
  const api = {
    mapServer: {
      async getBaseUrl() {
        throw expectedError
      },
    },
  }

  const { client } = setup(t, api)

  await assert.rejects(() => client.mapServer.getBaseUrl(), expectedError)
})

test('AppRpc client calls fail after server closes', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => {
    port1.close()
    port2.close()
  })

  const api = createMockRpcApi()
  const server = createAppRpcServer(api, port1)
  const client = createAppRpcClient(port2)

  port1.start()
  port2.start()

  // Verify it works first
  const result = await client.mapServer.getBaseUrl()
  assert.equal(result, MOCK_BASE_URL)

  server.close()
  closeAppRpcClient(client)

  await assert.rejects(() => client.mapServer.getBaseUrl(), {
    code: RpcChannelClosedError.code,
  })
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
