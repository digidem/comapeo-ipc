import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'

import {
  closeComapeoCoreClient,
  createComapeoCoreClient,
  getComapeoCoreClientEvents,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

// The events channel shares the port with method calls, so a round-trip call
// is a barrier: once it resolves, every event posted before it has arrived.

/**
 * @param {import('../src/client.js').ComapeoCoreClientEmitter} events
 * @param {keyof import('../src/lib/events.js').ComapeoCoreClientEvents} event
 * @returns {Promise<any[]>}
 */
function nextEvent(events, event) {
  return new Promise((resolve) => {
    events.once(event, (/** @type {any[]} */ ...args) => resolve(args))
  })
}

test('Manager events are delivered on the client emitter', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(getComapeoCoreClientEvents(client), 'local-peers')
  const peers = [{ deviceId: 'peer-a' }, { deviceId: 'peer-b' }]
  manager.emit('local-peers', peers)

  assert.deepEqual(await received, [peers])
})

test('Invite events are delivered on the client emitter', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(
    getComapeoCoreClientEvents(client),
    'invite-received',
  )
  const invite = { inviteId: 'invite-1', projectName: 'mapeo' }
  manager.invite.emit('invite-received', invite)

  assert.deepEqual(await received, [invite])
})

test('Error arguments are reconstructed as Errors', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const received = nextEvent(
    getComapeoCoreClientEvents(client),
    'map-share-error',
  )
  const error = new RangeError('bad bounds')
  const mapShare = { projectId: 'p1' }
  manager.emit('map-share-error', error, mapShare)

  const [receivedError, receivedMapShare] = await received
  assert.ok(receivedError instanceof Error)
  assert.equal(receivedError.name, 'RangeError')
  assert.equal(receivedError.message, 'bad bounds')
  assert.deepEqual(receivedMapShare, mapShare)
})

test('Project events carry the project id as their first argument', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = /** @type {any} */ (await client.getProject(projectId))

  const roleChange = nextEvent(
    getComapeoCoreClientEvents(client),
    'project:own-role-change',
  )
  await project.setOwnRole('member')
  assert.deepEqual(await roleChange, [projectId, { roleId: 'member' }])

  const syncState = nextEvent(
    getComapeoCoreClientEvents(client),
    'project:sync-state',
  )
  const serverProject = await serverManager.getProject(projectId)
  serverProject.$sync.setState({ data: { isSyncEnabled: true } })
  assert.deepEqual(await syncState, [
    projectId,
    { data: { isSyncEnabled: true } },
  ])
})

test('An event emitted during a call is delivered before the call resolves', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = /** @type {any} */ (await client.getProject(projectId))

  /** @type {string[]} */
  const order = []
  getComapeoCoreClientEvents(client).on('project:own-role-change', () =>
    order.push('event'),
  )
  await project.setOwnRole('coordinator').then(() => order.push('response'))

  assert.deepEqual(order, ['event', 'response'])
})

test('Project events keep flowing after a server-side close and re-open, with no re-subscription', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {unknown[]} */
  const states = []
  getComapeoCoreClientEvents(client).on(
    'project:sync-state',
    (_projectId, state) => states.push(state),
  )

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
  // The closed instance is detached: nothing it emits is relayed.
  first.$sync.setState({ instance: 'stale' })
  await project.$getProjectSettings()
  assert.deepEqual(states, [{ instance: 1 }, { instance: 2 }])
})

test('No events are relayed for a project the client has never opened', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  /** @type {unknown[]} */
  const states = []
  getComapeoCoreClientEvents(client).on(
    'project:sync-state',
    (_projectId, state) => states.push(state),
  )

  // Opened by the server alone (e.g. core re-joining a project): the relay
  // only attaches to an instance the client has been routed to.
  const serverOnly = await serverManager.getProject(projectId)
  serverOnly.$sync.setState({ seen: false })
  await client.listProjects()
  assert.deepEqual(states, [])

  const project = await client.getProject(projectId)
  await project.$getProjectSettings()
  serverOnly.$sync.setState({ seen: true })
  await project.$getProjectSettings()
  assert.deepEqual(states, [{ seen: true }])
})

test('Reflected EventEmitter methods throw and point at getComapeoCoreClientEvents', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const expected = { name: 'TypeError', message: /getComapeoCoreClientEvents/ }
  assert.throws(() => {
    // @ts-expect-error — removed from the client types on purpose
    client.on('local-peers', () => {})
  }, expected)
  assert.throws(() => {
    // @ts-expect-error
    client.invite.addListener('invite-received', () => {})
  }, expected)
  assert.throws(() => {
    // @ts-expect-error
    project.once('close', () => {})
  }, expected)
  assert.throws(() => {
    // @ts-expect-error
    project.$sync.on('sync-state', () => {})
  }, expected)
  assert.throws(() => {
    // @ts-expect-error
    project.$sync.removeListener('sync-state', () => {})
  }, expected)

  // Method calls through the same proxies still work.
  assert.deepEqual(await project.$sync.getState(), {
    data: { isSyncEnabled: false },
  })
})

test('Events are no longer delivered after the client is closed', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  let count = 0
  getComapeoCoreClientEvents(client).on('local-peers', () => count++)
  manager.emit('local-peers', [])
  await client.listProjects()
  assert.equal(count, 1)

  await closeComapeoCoreClient(client)
  manager.emit('local-peers', [])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(count, 1)
  assert.equal(
    getComapeoCoreClientEvents(client).listenerCount('local-peers'),
    1,
  )
})

test('Malformed frames and unknown events on the events channel are ignored', async (t) => {
  const manager = new FakeManager()
  const { client, port1 } = setup(t, manager)

  let count = 0
  const events = getComapeoCoreClientEvents(client)
  events.on('local-peers', () => count++)
  // @ts-expect-error — not in the event map
  events.on('not-an-event', () => count++)

  // Posting on port1 delivers to the client's port.
  port1.postMessage({ id: '@@comapeo/events', message: 'garbage' })
  port1.postMessage({ id: '@@comapeo/events', message: { event: 42 } })
  port1.postMessage({
    id: '@@comapeo/events',
    message: { event: 'local-peers' },
  })
  port1.postMessage({
    id: '@@comapeo/events',
    message: { event: 'local-peers', args: [[]], projectId: 7 },
  })
  port1.postMessage({
    id: '@@comapeo/events',
    message: { event: 'not-an-event', args: [] },
  })
  await client.listProjects()
  assert.equal(count, 0)

  const deferred = pDefer()
  getComapeoCoreClientEvents(client).once('local-peers', () =>
    deferred.resolve(),
  )
  manager.emit('local-peers', [])
  await deferred.promise
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

  /** @type {unknown[]} */
  const states = []
  getComapeoCoreClientEvents(client).on('project:sync-state', (_id, state) =>
    states.push(state),
  )
  const serverProject = await manager.getProject(projectId)
  assert.equal(serverProject.$sync.listenerCount('sync-state'), 0)
  serverProject.$sync.setState({ leaked: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(states, [])
})
