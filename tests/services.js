import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createComapeoServicesClient,
  closeComapeoServicesClient,
} from '../src/client.js'
import { createComapeoServicesServer } from '../src/server.js'
import { RpcChannelClosedError } from '../src/errors.js'

/** @import { ComapeoServicesApi } from '../src/server.js' */

/**
 * @param {import('node:test').TestContext} t
 * @param {ComapeoServicesApi} [servicesApi]
 */
function setup(t, servicesApi) {
  const { port1, port2 } = new MessageChannel()

  const api = servicesApi || createMockServices()
  const server = createComapeoServicesServer(api, port1)
  const client = createComapeoServicesClient(port2)

  port1.start()
  port2.start()

  t.after(() => {
    server.close()
    closeComapeoServicesClient(client)
    port1.close()
    port2.close()
  })

  return { server, client, api }
}

const MOCK_BASE_URL = 'http://localhost:3000'

/** @returns {ComapeoServicesApi} */
function createMockServices() {
  return {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }
}

test('Services client can call server method and get result', async (t) => {
  const { client } = setup(t)

  const result = await client.mapServer.getBaseUrl()

  assert.equal(result, MOCK_BASE_URL)
})

test('Services concurrent calls resolve correctly', async (t) => {
  let callCount = 0

  /** @type {ComapeoServicesApi} */
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

test('Services server method errors are propagated to client', async (t) => {
  const expectedError = new Error('Error')
  /** @type {ComapeoServicesApi} */
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

test('Services client calls fail after server closes', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => {
    port1.close()
    port2.close()
  })

  const api = createMockServices()
  const server = createComapeoServicesServer(api, port1)
  const client = createComapeoServicesClient(port2)

  port1.start()
  port2.start()

  // Verify it works first
  const result = await client.mapServer.getBaseUrl()
  assert.equal(result, MOCK_BASE_URL)

  server.close()
  closeComapeoServicesClient(client)

  await assert.rejects(() => client.mapServer.getBaseUrl(), {
    code: RpcChannelClosedError.code,
  })
})

test('Services server close is idempotent', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const api = createMockServices()
  const server = createComapeoServicesServer(api, port1)
  const client = createComapeoServicesClient(port2)

  port1.start()
  port2.start()

  // Closing server multiple times should not throw
  server.close()
  server.close()

  closeComapeoServicesClient(client)

  t.after(() => {
    port1.close()
    port2.close()
  })
})
