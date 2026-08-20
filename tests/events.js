import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'

import { ClientClosedError } from '../src/errors.js'
import { closeComapeoCoreClient } from '../src/client.js'

import { setup } from './helpers.js'

/**
 * Poll until `predicate` holds, for assertions about work the server does on
 * its own initiative (with no call to await).
 *
 * @param {() => boolean} predicate
 * @param {string} description
 */
async function waitFor(predicate, description) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Timed out waiting for ${description}`)
}
import { FakeManager } from './fake-manager.js'

test('Server events are forwarded to client listeners', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const deferred = pDefer()
  client.on('local-peers', (peers) => deferred.resolve(peers))

  // The `on` subscription is sent to the server asynchronously. A round-trip
  // call on the same channel acts as a barrier: messages are ordered, so once
  // this resolves the server has processed the earlier subscribe message.
  await client.listProjects()

  const peers = [{ deviceId: 'peer-a' }, { deviceId: 'peer-b' }]
  manager.emit('local-peers', peers)

  assert.deepEqual(await deferred.promise, peers)
})

test('Client listeners stop receiving events after removeListener', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  let count = 0
  const listener = () => {
    count++
  }
  client.on('local-peers', listener)
  await client.listProjects()

  manager.emit('local-peers', [{ deviceId: 'peer-a' }])
  // Give the forwarded event a tick to arrive, then unsubscribe.
  await client.listProjects()
  assert.equal(count, 1)

  client.removeListener('local-peers', listener)
  await client.listProjects()

  manager.emit('local-peers', [{ deviceId: 'peer-b' }])
  await client.listProjects()

  assert.equal(count, 1, 'no further events after removeListener')
})

test('Project events are forwarded to client listeners', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const deferred = pDefer()
  project.on('some-event', (value) => deferred.resolve(value))
  await project.$getProjectSettings()

  const serverProject = await serverManager.getProject(projectId)
  serverProject.emit('some-event', 'hello')

  assert.equal(await deferred.promise, 'hello')
})

// The load-bearing test for server-owned lifecycle: the server-side
// subscriptions must outlive the instance they were attached to and be
// replayed into the fresh instance when it re-opens — client listeners
// survive a close/re-open they never hear about.
test('Project event subscriptions survive a server-side close and re-open', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {unknown[]} */
  const received = []
  project.on('some-event', (value) => received.push(value))
  await project.$getProjectSettings()

  const firstInstance = await serverManager.getProject(projectId)
  firstInstance.emit('some-event', 'before-close')
  await project.$getProjectSettings()
  assert.deepEqual(received, ['before-close'])

  await firstInstance.close()

  // Re-open via any call; the subscriptions must be re-attached before the
  // buffered call is dispatched.
  await project.$getProjectSettings()

  const secondInstance = await serverManager.getProject(projectId)
  assert.notEqual(secondInstance, firstInstance)
  secondInstance.emit('some-event', 'after-reopen')
  await project.$getProjectSettings()

  assert.deepEqual(received, ['before-close', 'after-reopen'])
})

// Subscriptions are held per prop path, so a nested namespace that is itself
// an EventEmitter (core's `project.$sync`) must be re-attached to the matching
// namespace of the fresh instance — not just the project root.
test('Nested-namespace subscriptions survive a server-side close and re-open', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {unknown[]} */
  const received = []
  project.$sync.on('sync-state', (value) => received.push(value))
  await project.$sync.getState()

  const firstInstance = await serverManager.getProject(projectId)
  firstInstance.$sync.emit('sync-state', 'before-close')
  await project.$sync.getState()
  assert.deepEqual(received, ['before-close'])

  await firstInstance.close()
  await project.$sync.getState()

  const secondInstance = await serverManager.getProject(projectId)
  assert.notEqual(secondInstance, firstInstance)
  secondInstance.$sync.emit('sync-state', 'after-reopen')
  await project.$sync.getState()

  assert.deepEqual(received, ['before-close', 'after-reopen'])

  // Root and nested subscriptions are independent: the root emitter must not
  // have picked up the nested namespace's listener.
  secondInstance.emit('sync-state', 'from-root')
  await project.$sync.getState()
  assert.deepEqual(received, ['before-close', 'after-reopen'])
})

test('Unsubscribed project events are not replayed on re-open', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  let count = 0
  const listener = () => {
    count++
  }
  project.on('some-event', listener)
  await project.$getProjectSettings()
  project.removeListener('some-event', listener)
  await project.$getProjectSettings()

  const firstInstance = await serverManager.getProject(projectId)
  await firstInstance.close()

  await project.$getProjectSettings()
  const secondInstance = await serverManager.getProject(projectId)
  secondInstance.emit('some-event')
  await project.$getProjectSettings()

  assert.equal(count, 0, 'unsubscribed event must not be re-subscribed')
})

test('A subscription made while the project is closed server-side still takes effect', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const firstInstance = await serverManager.getProject(projectId)
  await firstInstance.close()

  // Subscribing while no instance is live: the ON frame itself must wake the
  // project up (subscribing expresses interest) and land on the fresh
  // instance.
  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const deferred = pDefer()
  project.on('some-event', (value) => deferred.resolve(value))
  await project.$getProjectSettings()

  const secondInstance = await serverManager.getProject(projectId)
  secondInstance.emit('some-event', 'woken')
  assert.equal(await deferred.promise, 'woken')
})

// Subscribing is itself a reason to open a project: a consumer that only
// listens (a component mounted on `$sync` events, or #89's post-restart
// resubscribe) would otherwise never receive anything. Every other test here
// makes a method call after subscribing, which masks this.
test('Subscribing alone re-opens a dormant project, with no further calls', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const firstInstance = await serverManager.getProject(projectId)
  const opensBefore = serverManager.getProjectCallCount.get(projectId) ?? 0
  await firstInstance.close()

  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const deferred = pDefer()
  project.on('some-event', (value) => deferred.resolve(value))

  await waitFor(
    () => (serverManager.getProjectCallCount.get(projectId) ?? 0) > opensBefore,
    'the server to re-open the project for the subscription alone',
  )

  const secondInstance = await serverManager.getProject(projectId)
  assert.notEqual(secondInstance, firstInstance)
  secondInstance.emit('some-event', 'woken')
  assert.equal(await deferred.promise, 'woken')
})

test('EventEmitter subscribe methods throw synchronously after the client is closed', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await closeComapeoCoreClient(client)

  assert.throws(() => client.on('local-peers', () => {}), {
    code: ClientClosedError.code,
  })
  assert.throws(() => project.on('some-event', () => {}), {
    code: ClientClosedError.code,
  })
})

test('EventEmitter unsubscribe methods are no-ops after the client is closed', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  const listener = () => {}
  project.on('some-event', listener)

  await closeComapeoCoreClient(client)

  // Removing a listener from a dead client is correct teardown (React effect
  // cleanup runs against stale references) — it must not throw.
  assert.doesNotThrow(() => project.removeListener('some-event', listener))
  assert.doesNotThrow(() => project.off('some-event', listener))
  assert.doesNotThrow(() => client.removeAllListeners('local-peers'))
})
