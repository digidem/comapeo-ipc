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

test('Project events are still forwarded after the project is closed and re-opened', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Subscribe to a project event, then close the project from the server side
  // (bypassing the client). The `close` event must be forwarded to the client
  // so a consumer knows it needs to re-subscribe (see README).
  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const closeDeferred = pDefer()
  project.on('close', () => closeDeferred.resolve())
  // Round-trip so the 'close' subscription is registered server-side (FIFO
  // channel) before the close below emits.
  await project.$getProjectSettings()

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  await closeDeferred.promise

  // Re-open and re-subscribe: a fresh subscription on the same wrapper now
  // targets the re-opened instance.
  const reopened = await client.getProject(projectId)
  await reopened.$getProjectSettings()
  assert.ok(reopened)
})

test('EventEmitter methods throw synchronously after the client is closed', async (t) => {
  const { client } = setup(t)

  await closeComapeoCoreClient(client)

  assert.throws(() => client.on('local-peers', () => {}), {
    code: ClientClosedError.code,
  })
})

test('A listener subscribed after the close event receives events from the re-opened instance', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {import('p-defer').DeferredPromise<void>} */
  const closed = pDefer()
  project.once('close', () => closed.resolve())
  await project.$getProjectSettings()

  await (await serverManager.getProject(projectId)).close()
  await closed.promise

  // README pattern: observe `close`, get the project again, re-subscribe.
  const reopened = await client.getProject(projectId)
  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const received = pDefer()
  reopened.on('custom', (payload) => received.resolve(payload))
  // Round-trip: the ON message is now processed server-side, and this call
  // re-opens the project.
  await reopened.$getProjectSettings()

  const liveProject = await serverManager.getProject(projectId)
  liveProject.emit('custom', 'hello')

  const timeout = new Promise((resolve) => setTimeout(resolve, 200, 'timeout'))
  assert.equal(
    await Promise.race([received.promise, timeout]),
    'hello',
    'event from the re-opened instance was not forwarded',
  )
})

test("A persistent 'close' listener is notified on every close, not only the first", async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {import('p-defer').DeferredPromise<void>} */
  const firstClose = pDefer()
  /** @type {import('p-defer').DeferredPromise<void>} */
  const secondClose = pDefer()
  let count = 0
  project.on('close', () => {
    count++
    if (count === 1) firstClose.resolve()
    else if (count === 2) secondClose.resolve()
  })
  await project.$getProjectSettings()

  await (await serverManager.getProject(projectId)).close()
  await firstClose.promise

  // Transparently re-open, then close again from the server side.
  await project.$getProjectSettings()
  await (await serverManager.getProject(projectId)).close()

  const timeout = new Promise((resolve) => setTimeout(resolve, 200, 'timeout'))
  assert.equal(
    await Promise.race([secondClose.promise.then(() => 'closed'), timeout]),
    'closed',
    'second close event was not forwarded',
  )
})

test('Nested-namespace events are forwarded after the project is closed and re-opened', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {Array<unknown>} */
  const updates = []
  project.observation.on('updated-docs', (docs) => updates.push(docs))
  await project.$getProjectSettings()

  // Sanity: forwarded while open.
  await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })
  await project.$getProjectSettings()
  assert.equal(updates.length, 1, 'event forwarded before close')

  await (await serverManager.getProject(projectId)).close()

  // Transparently re-opens; the write on the fresh instance emits again.
  await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })
  await project.$getProjectSettings()
  assert.equal(updates.length, 2, 'event not forwarded after re-open')
})

test('A listener subscribed after a server-side close, before any call, receives events', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  await (await serverManager.getProject(projectId)).close()

  /** @type {import('p-defer').DeferredPromise<unknown>} */
  const received = pDefer()
  project.on('custom', (payload) => received.resolve(payload))
  await project.$getProjectSettings()
  ;(await serverManager.getProject(projectId)).emit('custom', 'hello')

  const timeout = new Promise((resolve) => setTimeout(resolve, 200, 'timeout'))
  assert.equal(
    await Promise.race([received.promise, timeout]),
    'hello',
    'event from the re-opened instance was not forwarded',
  )
})
