import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'

import {
  closeComapeoCoreClient,
  createComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

// A round-trip call acts as a barrier: once it resolves, every ON/EMIT
// message posted before it has been processed by the other end.

/**
 * Wait for the next emission of `event` on `emitter`.
 * @param {any} emitter
 * @param {string} event
 */
function nextEvent(emitter, event) {
  return new Promise((resolve) => {
    emitter.once(event, (/** @type {any[]} */ ...args) => resolve(args))
  })
}

test('Manager events are delivered on the client', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(client, 'local-peers')
  // Barrier: ensure the ON message is processed before we emit.
  await client.listProjects()
  const peers = [{ deviceId: 'peer-a' }, { deviceId: 'peer-b' }]
  manager.emit('local-peers', peers)

  assert.deepEqual(await received, [peers])
})

test('Invite events are delivered on the client', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(
    /** @type {any} */ (client).invite,
    'invite-received',
  )
  // Barrier: ensure the ON message is processed before we emit.
  await client.listProjects()
  const invite = { inviteId: 'invite-1', projectName: 'mapeo' }
  manager.invite.emit('invite-received', invite)

  assert.deepEqual(await received, [invite])
})

test('Error arguments are reconstructed as Errors', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(client, 'map-share-error')
  // Barrier: ensure the ON message is processed before we emit.
  await client.listProjects()
  const error = new RangeError('bad bounds')
  const mapShare = { projectId: 'p1' }
  manager.emit('map-share-error', error, mapShare)

  const [receivedError, receivedMapShare] = await received
  assert.ok(receivedError instanceof Error)
  assert.equal(receivedError.name, 'RangeError')
  assert.equal(receivedError.message, 'bad bounds')
  assert.deepEqual(receivedMapShare, mapShare)
})

test('Project events are delivered on the project client', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = /** @type {any} */ (await client.getProject(projectId))

  const roleChange = nextEvent(project, 'own-role-change')
  // Barrier: ensure the ON message is processed before we emit.
  await project.$getProjectSettings()
  await project.setOwnRole('member')

  assert.deepEqual(await roleChange, [{ roleId: 'member' }])

  const syncState = nextEvent(project.$sync, 'sync-state')
  // Barrier: ensure the ON message is processed before we emit.
  await project.$getProjectSettings()
  const serverProject = await serverManager.getProject(projectId)
  serverProject.$sync.setState({ data: { isSyncEnabled: true } })

  assert.deepEqual(await syncState, [{ data: { isSyncEnabled: true } }])
})

test('An event emitted during a call is delivered before the call resolves', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = /** @type {any} */ (await client.getProject(projectId))

  /** @type {string[]} */
  const order = []
  project.on('own-role-change', () => order.push('event'))
  // Barrier: ensure the ON message is processed.
  await project.$getProjectSettings()
  await project.setOwnRole('coordinator').then(() => order.push('response'))

  assert.deepEqual(order, ['event', 'response'])
})

test('Project events keep flowing after a server-side close and re-open, with no re-subscription', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = /** @type {any} */ (await client.getProject(projectId))

  /** @type {unknown[]} */
  const states = []
  project.$sync.on('sync-state', (/** @type {any} */ state) =>
    states.push(state),
  )
  // Barrier: ensure the ON message is processed.
  await project.$getProjectSettings()

  const first = await serverManager.getProject(projectId)
  first.$sync.setState({ instance: 1 })
  await project.$getProjectSettings()
  assert.deepEqual(states, [{ instance: 1 }])

  // Close behind the client's back, then let the next call re-open it.
  await first.close()
  await project.$getProjectSettings()
  const second = await serverManager.getProject(projectId)
  assert.notEqual(second, first)

  second.$sync.setState({ instance: 2 })
  await project.$getProjectSettings()
  assert.deepEqual(states, [{ instance: 1 }, { instance: 2 }])
})

test('No events are relayed for a project the client has never opened', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Opened by the server alone (e.g. core re-joining a project): the relay
  // only attaches to an instance the client has been routed to.
  const serverOnly = await serverManager.getProject(projectId)
  serverOnly.$sync.setState({ seen: false })
  await client.listProjects()

  const project = /** @type {any} */ (await client.getProject(projectId))

  /** @type {unknown[]} */
  const states = []
  project.$sync.on('sync-state', (/** @type {any} */ state) =>
    states.push(state),
  )
  // Barrier: ensure the ON message is processed.
  await project.$getProjectSettings()
  serverOnly.$sync.setState({ seen: true })
  await project.$getProjectSettings()
  assert.deepEqual(states, [{ seen: true }])
})

test('Events are no longer delivered after the client is closed', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  let count = 0
  client.on('local-peers', () => count++)
  // Barrier: ensure the ON message is processed.
  await client.listProjects()
  manager.emit('local-peers', [])
  await client.listProjects()
  assert.equal(count, 1)

  await closeComapeoCoreClient(client)
  manager.emit('local-peers', [])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(count, 1)
})

test('A project open still in flight when the server closes relays nothing', async (t) => {
  const entered = pDefer()
  const gate = pDefer()
  class GatedManager extends FakeManager {
    /** @param {string} projectId */
    async getProject(projectId) {
      entered.resolve()
      await gate.promise
      return super.getProject(projectId)
    }
  }
  const manager = new GatedManager()
  const { port1, port2 } = new MessageChannel()
  const server = createComapeoCoreServer(/** @type {any} */ (manager), port1)
  const client = createComapeoCoreClient(port2, { timeout: 100 })
  port1.start()
  port2.start()
  t.after(async () => {
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  const projectId = await client.createProject({ name: 'mapeo' })
  const opening = client.getProject(projectId)
  await entered.promise
  server.close()
  gate.resolve()
  await assert.rejects(opening)

  const serverProject = await manager.getProject(projectId)
  serverProject.$sync.setState({ leaked: true })
  await new Promise((resolve) => setImmediate(resolve))
})
