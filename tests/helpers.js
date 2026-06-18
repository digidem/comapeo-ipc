import { createMapeoClient, closeMapeoClient } from '../src/client.js'
import { createMapeoServer } from '../src/server.js'

import { FakeManager } from './fake-manager.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {FakeManager} [manager]
 */
export function setup(t, manager = new FakeManager()) {
  const { port1, port2 } = new MessageChannel()

  const server = createMapeoServer(/** @type {any} */ (manager), port1)
  const client = createMapeoClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    server.close()
    await closeMapeoClient(client)
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
