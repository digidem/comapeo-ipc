import test from 'node:test'
import assert from 'node:assert/strict'
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
import { TransportClosedError } from '../src/errors.js'

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

  // The reference itself is unaffected — only the in-flight call died.
  // (There is no server right now, so just check the next call is a fresh
  // pending promise, not an instant rejection.)
  const nextCall = project.$getProjectSettings()
  let settled = false
  nextCall.then(
    () => (settled = true),
    () => (settled = true),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'post-reset call is pending, not dead')
  notifyCoreClientTransportReset(client)
  await assert.rejects(() => nextCall, { code: TransportClosedError.code })
})

test('Project references survive a server restart', async (t) => {
  const { client, server, port1 } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const { newManager } = restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)

  // The fresh manager mints the same project id ('project-1'). The held
  // reference must keep working against the restarted server — its channel
  // is keyed by project id, which the new server serves identically. No
  // re-getProject required.
  const newProjectId = await client.createProject({ name: 'mapeo-after' })
  assert.equal(newProjectId, projectId, 'test setup: same project id reminted')

  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo-after')
  assert.equal(newManager.getProjectCallCount.get(projectId), 1)

  // getProject still hands back the same permanent reference.
  const again = await client.getProject(projectId)
  assert.equal(again, project)
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

test('Project event subscriptions are replayed across a server restart', async (t) => {
  const { client, server, port1 } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const deferred = pDefer()
  project.on('some-event', (value) => deferred.resolve(value))
  await project.$getProjectSettings()

  const { newManager } = restartServer(t, server, port1)
  notifyCoreClientTransportReset(client)
  await client.createProject({ name: 'mapeo' }) // remints project-1

  // Replaying the project subscription also re-opens the project on the
  // restarted server — an active listener is an expression of interest.
  resubscribeCoreClient(client)
  await project.$getProjectSettings()

  const instance = await newManager.getProject(projectId)
  instance.emit('some-event', 'after-restart')
  assert.equal(await deferred.promise, 'after-restart')
})

test('Reset and resubscribe are no-ops after the client is closed', async (t) => {
  const { client } = setup(t)
  await closeComapeoCoreClient(client)

  assert.doesNotThrow(() => notifyCoreClientTransportReset(client))
  assert.doesNotThrow(() => resubscribeCoreClient(client))
})

test('Services client: reset rejects in-flight calls; resubscribe is safe', async (t) => {
  const { port1, port2 } = new MessageChannel()
  const services = {
    mapServer: {
      getBaseUrl: () => new Promise(() => {}), // never answers
    },
  }
  const server = createComapeoCoreServer(
    /** @type {any} */ (new FakeManager()),
    port1,
  )
  const servicesServer = createComapeoServicesServer(services, port1)
  const servicesClient = createComapeoServicesClient(port2)
  port1.start()
  port2.start()
  t.after(() => {
    server.close()
    servicesServer.close()
    closeComapeoServicesClient(servicesClient)
    port1.close()
    port2.close()
  })

  const inFlight = servicesClient.mapServer.getBaseUrl()
  notifyServicesClientTransportReset(servicesClient)

  await assert.rejects(() => inFlight, { code: TransportClosedError.code })

  assert.doesNotThrow(() => resubscribeServicesClient(servicesClient))
})
