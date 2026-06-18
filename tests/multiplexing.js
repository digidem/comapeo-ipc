import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
  createComapeoServicesClient,
  closeComapeoServicesClient,
} from '../src/client.js'
import {
  createComapeoCoreServer,
  createComapeoServicesServer,
} from '../src/server.js'

import { FakeManager } from './fake-manager.js'

/** @import { ComapeoServicesApi } from '../src/server.js' */

const MOCK_BASE_URL = 'http://localhost:3000'

// The whole reason this module exists on top of rpc-reflector: several logical
// RPC endpoints (manager, the project-routing helper channel, per-project
// channels, and the services API) are multiplexed over a SINGLE message port,
// distinguished by a subchannel id. These tests drive the core and services
// endpoints over one shared port and assert there's no cross-talk.
test('Core and services clients coexist on a single shared message port', async (t) => {
  // The core server's per-project router and the services server share this
  // port; services traffic must not be mistaken for an unroutable message.
  /** @type {string[]} */
  const noise = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (/** @type {unknown[]} */ ...args) =>
    noise.push(String(args[0]))
  console.error = (/** @type {unknown[]} */ ...args) =>
    noise.push(String(args[0]))
  t.after(() => {
    console.warn = originalWarn
    console.error = originalError
  })

  const { port1, port2 } = new MessageChannel()

  const manager = new FakeManager()
  /** @type {ComapeoServicesApi} */
  const services = {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }

  const coreServer = createComapeoCoreServer(
    /** @type {any} */ (manager),
    port1,
  )
  const servicesServer = createComapeoServicesServer(services, port1)

  const coreClient = createComapeoCoreClient(port2)
  const servicesClient = createComapeoServicesClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    coreServer.close()
    servicesServer.close()
    await closeComapeoCoreClient(coreClient)
    closeComapeoServicesClient(servicesClient)
    port1.close()
    port2.close()
  })

  const projectId = await coreClient.createProject({ name: 'mapeo' })
  const baseUrl = await servicesClient.mapServer.getBaseUrl()

  assert.ok(projectId)
  assert.equal(baseUrl, MOCK_BASE_URL)

  // Interleave concurrent traffic across both endpoints (and a per-project
  // channel) on the same port; each call must land on its own handler.
  const project = await coreClient.getProject(projectId)
  const [settings, url, projects] = await Promise.all([
    project.$getProjectSettings(),
    servicesClient.mapServer.getBaseUrl(),
    coreClient.listProjects(),
  ])

  assert.equal(settings.name, 'mapeo')
  assert.equal(url, MOCK_BASE_URL)
  assert.equal(projects.length, 1)

  assert.deepEqual(
    noise,
    [],
    'no spurious warnings/errors for shared-port traffic',
  )
})

test('Closing one endpoint on a shared port leaves the other working', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const manager = new FakeManager()
  /** @type {ComapeoServicesApi} */
  const services = {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }

  const coreServer = createComapeoCoreServer(
    /** @type {any} */ (manager),
    port1,
  )
  const servicesServer = createComapeoServicesServer(services, port1)

  const coreClient = createComapeoCoreClient(port2)
  const servicesClient = createComapeoServicesClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    coreServer.close()
    await closeComapeoCoreClient(coreClient)
    port1.close()
    port2.close()
  })

  // Tear down only the services endpoint. The core endpoint shares the same
  // port and must be unaffected.
  servicesServer.close()
  closeComapeoServicesClient(servicesClient)

  const projectId = await coreClient.createProject({ name: 'mapeo' })
  assert.ok(projectId)
  const projects = await coreClient.listProjects()
  assert.equal(projects.length, 1)
})
