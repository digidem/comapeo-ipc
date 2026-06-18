import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createComapeoServicesClient,
  closeComapeoServicesClient,
} from '../src/client.js'
import { createComapeoServicesServer } from '../src/server.js'
import { RpcTimeoutError } from '../src/errors.js'

test('Calls reject with RpcTimeoutError when the server never responds', async (t) => {
  const { port1, port2 } = new MessageChannel()

  /** @type {import('../src/server.js').ComapeoServicesApi} */
  const api = {
    mapServer: {
      // Never settles, so the only way the call can complete is the client
      // timeout firing.
      getBaseUrl: () => new Promise(() => {}),
    },
  }

  const server = createComapeoServicesServer(api, port1)
  const client = createComapeoServicesClient(port2, { timeout: 50 })

  port1.start()
  port2.start()

  t.after(() => {
    server.close()
    closeComapeoServicesClient(client)
    port1.close()
    port2.close()
  })

  await assert.rejects(() => client.mapServer.getBaseUrl(), {
    code: RpcTimeoutError.code,
  })
})
