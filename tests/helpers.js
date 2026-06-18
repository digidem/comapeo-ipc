import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

import { FakeManager } from './fake-manager.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {FakeManager} [manager]
 */
export function setup(t, manager = new FakeManager()) {
  const { port1, port2 } = new MessageChannel()

  const server = createComapeoCoreServer(/** @type {any} */ (manager), port1)
  const client = createComapeoCoreClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    server.close()
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  return {
    port1,
    port2,
    server,
    client,
    serverManager: manager,
  }
}
