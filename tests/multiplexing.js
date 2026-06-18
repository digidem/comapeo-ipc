import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createMapeoClient,
  closeMapeoClient,
  createAppRpcClient,
  closeAppRpcClient,
} from '../src/client.js'
import { createMapeoServer, createAppRpcServer } from '../src/server.js'

import { FakeManager } from './fake-manager.js'

const MOCK_BASE_URL = 'http://localhost:3000'

// The whole reason this module exists on top of rpc-reflector: several logical
// RPC endpoints (manager, the mapeo-rpc helper channel, per-project channels,
// and app-rpc) are multiplexed over a SINGLE message port, distinguished by a
// subchannel id. These tests drive the manager and app-rpc endpoints over one
// shared port and assert there's no cross-talk.
test('Manager and App RPC coexist on a single shared message port', async (t) => {
  // The manager server's per-project router and the app-rpc server share this
  // port; app-rpc traffic must not be mistaken for an unroutable message.
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
  /** @type {import('../src/server.js').RpcApi} */
  const appApi = {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }

  const mapeoServer = createMapeoServer(/** @type {any} */ (manager), port1)
  const appServer = createAppRpcServer(appApi, port1)

  const mapeoClient = createMapeoClient(port2)
  const appClient = createAppRpcClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    mapeoServer.close()
    appServer.close()
    await closeMapeoClient(mapeoClient)
    closeAppRpcClient(appClient)
    port1.close()
    port2.close()
  })

  const projectId = await mapeoClient.createProject({ name: 'mapeo' })
  const baseUrl = await appClient.mapServer.getBaseUrl()

  assert.ok(projectId)
  assert.equal(baseUrl, MOCK_BASE_URL)

  // Interleave concurrent traffic across both endpoints (and a per-project
  // channel) on the same port; each call must land on its own handler.
  const project = await mapeoClient.getProject(projectId)
  const [settings, url, projects] = await Promise.all([
    project.$getProjectSettings(),
    appClient.mapServer.getBaseUrl(),
    mapeoClient.listProjects(),
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
  /** @type {import('../src/server.js').RpcApi} */
  const appApi = {
    mapServer: {
      async getBaseUrl() {
        return MOCK_BASE_URL
      },
    },
  }

  const mapeoServer = createMapeoServer(/** @type {any} */ (manager), port1)
  const appServer = createAppRpcServer(appApi, port1)

  const mapeoClient = createMapeoClient(port2)
  const appClient = createAppRpcClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    mapeoServer.close()
    await closeMapeoClient(mapeoClient)
    port1.close()
    port2.close()
  })

  // Tear down only the app-rpc endpoint. The manager endpoint shares the same
  // port and must be unaffected.
  appServer.close()
  closeAppRpcClient(appClient)

  const projectId = await mapeoClient.createProject({ name: 'mapeo' })
  assert.ok(projectId)
  const projects = await mapeoClient.listProjects()
  assert.equal(projects.length, 1)
})
