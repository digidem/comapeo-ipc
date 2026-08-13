import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import pDefer from 'p-defer'

import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
  notifyCoreClientTransportReset,
  resubscribeCoreClient,
  createComapeoServicesClient,
  closeComapeoServicesClient,
  notifyServicesClientTransportReset,
  resubscribeServicesClient,
} from '../src/client.js'
import {
  createComapeoCoreServer,
  createComapeoServicesServer,
} from '../src/server.js'
import { ProjectClosedError, TransportClosedError } from '../src/errors.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

/**
 * Simulate the server process dying and restarting while the client (and the
 * message port it holds) stays alive — the Android foreground-service restart
 * case: close the old server and serve a fresh manager over the same port.
 *
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof setup>['server']} oldServer
 * @param {MessagePort} serverPort
 */
function restartServer(t, oldServer, serverPort) {
  oldServer.close()
  const newManager = new FakeManager()
  const newServer = createComapeoCoreServer(
    /** @type {any} */ (newManager),
    serverPort,
  )
  t.after(() => newServer.close())
  return { newManager, newServer }
}

test('Reset rejects in-flight manager and getProject calls with TransportClosedError', async (t) => {
  const { client, server } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  // With the server gone, these calls can never be answered.
  server.close()
  const inFlightManagerCall = client.listProjects()
  const inFlightGetProject = client.getProject(projectId)

  notifyCoreClientTransportReset(client)

  await assert.rejects(() => inFlightManagerCall, {
    code: TransportClosedError.code,
  })
  await assert.rejects(() => inFlightGetProject, {
    code: TransportClosedError.code,
  })
})

test('Reset rejects in-flight project method calls with TransportClosedError', async (t) => {
  const { client, server } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  server.close()
  const inFlightProjectCall = project.$getProjectSettings()

  notifyCoreClientTransportReset(client)

  await assert.rejects(() => inFlightProjectCall, {
    code: TransportClosedError.code,
  })
})

test('Reset does not resubscribe; resubscribeCoreClient replays subscriptions and is idempotent', async (t) => {
  const { client, server, port1 } = setup(t)

  /** @type {unknown[]} */
  const received = []
  client.on('local-peers', (peers) => received.push(peers))
  await client.listProjects()

  const { newManager } = restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)
  // Round-trip barrier: had the reset replayed the subscription, the ON
  // message would have been processed by now.
  await client.listProjects()

  const peers = [{ deviceId: 'peer-a' }]
  newManager.emit('local-peers', peers)
  // Barrier to let any (unexpected) forwarded event flush through the port.
  await client.listProjects()
  assert.deepEqual(received, [], 'reset alone does not replay subscriptions')

  // Repeated calls are safe: the server ignores duplicate subscriptions, so
  // events are not double-delivered.
  resubscribeCoreClient(client)
  resubscribeCoreClient(client)
  await client.listProjects()

  newManager.emit('local-peers', peers)
  await client.listProjects()
  assert.deepEqual(
    received,
    [peers],
    'event is delivered exactly once after resubscribing',
  )
})

test('Stale project wrapper is not reused after reset, even when the new server mints the same instance id', async (t) => {
  const { client, server, port1 } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const staleProject = await client.getProject(projectId)
  await staleProject.$getProjectSettings()

  const { newManager } = restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)

  // The fresh manager mints the same project id ('project-1') and the fresh
  // server's instance counter restarts, so `assertProjectExists` returns an
  // instance id identical to the one the stale wrapper is bound to — the
  // cache must have been dropped for this to return a working wrapper.
  const newProjectId = await client.createProject({ name: 'mapeo' })
  assert.equal(newProjectId, projectId, 'test setup: same project id reminted')

  const freshProject = await client.getProject(projectId)
  assert.notEqual(
    freshProject,
    staleProject,
    'getProject returns a fresh wrapper, not the stale one',
  )
  const settings = await freshProject.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  // Only the fresh manager's project should be reachable.
  assert.equal(newManager.getProjectCallCount.get(projectId), 1)
})

test('Reset fires each project wrapper’s close event exactly once', async (t) => {
  const { client, server, port1 } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  let closeCount = 0
  const noop = () => {}
  project.on('close', () => {
    closeCount++
    // Teardown code commonly removes listeners from inside a close
    // listener; this must not throw mid-teardown.
    assert.doesNotThrow(() => project.off('own-role-change', noop))
  })

  restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)
  assert.equal(closeCount, 1, 'close listener ran synchronously with reset')

  // A second reset finds no open project clients; the closed wrapper's
  // listeners must not fire again.
  notifyCoreClientTransportReset(client)
  assert.equal(closeCount, 1)
})

test('Stale project references behave like closed projects after reset', async (t) => {
  const { client, server, port1 } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const staleProject = await client.getProject(projectId)

  restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)

  await assert.rejects(() => staleProject.$getProjectSettings(), {
    code: ProjectClosedError.code,
  })
  await assert.rejects(
    () =>
      staleProject.observation.create({
        schemaName: 'observation',
        attachments: [],
        tags: {},
      }),
    { code: ProjectClosedError.code },
  )
  // `close()` on a stale reference resolves like an already-closed project.
  await staleProject.close()

  // Removing listeners from a stale reference is valid teardown (e.g. React
  // effect cleanup) and must not throw; subscribing is still an error.
  const noop = () => {}
  assert.doesNotThrow(() => staleProject.off('close', noop))
  assert.doesNotThrow(() => staleProject.removeListener('close', noop))
  assert.doesNotThrow(() => staleProject.removeAllListeners())
  assert.doesNotThrow(
    () => staleProject.off('own-role-change', noop).off('close', noop),
    'unsubscribe no-ops keep chaining semantics',
  )
  assert.throws(
    () => staleProject.on('close', noop),
    { code: ProjectClosedError.code },
    'subscribe methods still throw on a stale reference',
  )
  assert.throws(() => staleProject.once('close', noop), {
    code: ProjectClosedError.code,
  })
})

test('getProject that is in flight during reset rejects, and a retry returns a working client', async (t) => {
  const manager = new FakeManager()
  /** @type {import('p-defer').DeferredPromise<never>} */
  const gate = pDefer()
  // Hold `getProject` open server-side so the routing call is still in
  // flight when the reset lands.
  const originalGetProject = manager.getProject.bind(manager)
  manager.getProject = () => gate.promise

  const { client, server, port1 } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  const inFlightGetProject = client.getProject(projectId)

  const { newManager } = restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)

  await assert.rejects(() => inFlightGetProject, {
    code: TransportClosedError.code,
  })
  manager.getProject = originalGetProject

  // The dedupe map entry for the rejected call must not poison the retry.
  await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
  assert.ok(newManager.getProjectCallCount.get(projectId))
})

test('Reset is a no-op after the client is closed', async (t) => {
  const { port1, port2 } = new MessageChannel()
  const manager = new FakeManager()
  const server = createComapeoCoreServer(/** @type {any} */ (manager), port1)
  const client = createComapeoCoreClient(port2)
  port1.start()
  port2.start()
  t.after(() => {
    server.close()
    port1.close()
    port2.close()
  })

  await closeComapeoCoreClient(client)

  assert.doesNotThrow(() => notifyCoreClientTransportReset(client))
  assert.doesNotThrow(() => resubscribeCoreClient(client))
})

test('Services client reset rejects in-flight calls; resubscribeServicesClient replays subscriptions', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => {
    port1.close()
    port2.close()
  })

  const makeApi = () =>
    Object.assign(new EventEmitter(), {
      mapServer: {
        async getBaseUrl() {
          return 'http://localhost:3000'
        },
      },
    })

  const oldServer = createComapeoServicesServer(makeApi(), port1)
  const client = createComapeoServicesClient(port2)
  port1.start()
  port2.start()
  t.after(() => closeComapeoServicesClient(client))

  /** @type {unknown[]} */
  const received = []
  const eventfulClient = /** @type {any} */ (client)
  eventfulClient.on('service-event', (/** @type {unknown} */ e) =>
    received.push(e),
  )
  await client.mapServer.getBaseUrl()

  oldServer.close()
  const inFlightCall = client.mapServer.getBaseUrl()

  // Restart: a fresh services server (with a fresh emitter) on the same port.
  const newApi = makeApi()
  const newServer = createComapeoServicesServer(newApi, port1)
  t.after(() => newServer.close())

  notifyServicesClientTransportReset(client)

  await assert.rejects(() => inFlightCall, {
    code: TransportClosedError.code,
  })

  // Reset alone does not replay subscriptions.
  await client.mapServer.getBaseUrl()
  newApi.emit('service-event', 'dropped')
  await client.mapServer.getBaseUrl()
  assert.deepEqual(received, [])

  // Safe to call repeatedly: the server ignores duplicate subscriptions.
  resubscribeServicesClient(client)
  resubscribeServicesClient(client)
  // Round-trip barrier so the replayed subscribe has been processed.
  await client.mapServer.getBaseUrl()
  newApi.emit('service-event', 'payload')
  // Let the forwarded event flush through the port.
  await client.mapServer.getBaseUrl()

  assert.deepEqual(received, ['payload'])
})

test('Services client reset and resubscribe are no-ops after close', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => {
    port1.close()
    port2.close()
  })

  const client = createComapeoServicesClient(port2)
  port2.start()
  closeComapeoServicesClient(client)

  assert.doesNotThrow(() => notifyServicesClientTransportReset(client))
  assert.doesNotThrow(() => resubscribeServicesClient(client))
})
