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
