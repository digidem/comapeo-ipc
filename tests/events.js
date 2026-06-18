import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'

import { ClientClosedError, ProjectClosedError } from '../src/errors.js'
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

test('EventEmitter methods throw synchronously after the project is closed', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await project.close()

  // Emitter methods are not awaited by callers, so a rejected promise would
  // surface as an unhandled rejection — they throw at the call site instead.
  assert.throws(() => project.on('some-event', () => {}), {
    code: ProjectClosedError.code,
  })
  assert.throws(() => project.removeListener('some-event', () => {}), {
    code: ProjectClosedError.code,
  })
})

test('EventEmitter methods throw synchronously after the client is closed', async (t) => {
  const { client } = setup(t)

  await closeComapeoCoreClient(client)

  assert.throws(() => client.on('local-peers', () => {}), {
    code: ClientClosedError.code,
  })
})
