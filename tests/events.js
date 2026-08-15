import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'

import { ClientClosedError } from '../src/errors.js'
import { closeComapeoCoreClient } from '../src/client.js'

import { setup } from './helpers.js'
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

// The load-bearing test for server-owned lifecycle: rpc-reflector's
// server-side subscriptions die with each per-instance server, so the IPC
// server must replay the client's subscriptions into the fresh instance when
// it re-opens — client listeners survive a close/re-open they never hear
// about.
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

  // Re-open via any call; the subscription tape must be replayed before the
  // buffered call is dispatched.
  await project.$getProjectSettings()

  const secondInstance = await serverManager.getProject(projectId)
  assert.notEqual(secondInstance, firstInstance)
  secondInstance.emit('some-event', 'after-reopen')
  await project.$getProjectSettings()

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
