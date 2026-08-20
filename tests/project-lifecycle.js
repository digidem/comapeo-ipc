import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'
import { NotFoundError } from '@comapeo/core/errors.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'
import { ProjectLeftError } from '../src/errors.js'
import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

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

// Project instance lifecycle is owned by the server: project references are
// permanent, and the server transparently re-opens a project whose instance
// was closed server-side (resource policy, addProject on re-invite, server
// restart). The one deliberate exception is a left project, which rejects
// with ProjectLeftError until re-joined. These tests pin that contract.

test('Calls work transparently after a server-side close', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  // Close the project from the server side, bypassing the client. The
  // client's reference must keep working: the next call re-opens the
  // project on the same channel.
  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  const fetched = await project.observation.getByDocId(obs.docId)
  assert.equal(fetched.docId, obs.docId)

  // The server really did cycle the instance: IPC open + this test's own
  // serverManager.getProject above + IPC re-open.
  assert.equal(serverManager.getProjectCallCount.get(projectId), 3)
})

test('Calls work immediately after a server-side close, with no event wait', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  // No round-trip, no close notification consumed — the very next call must
  // succeed against a fresh instance.
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('getProject after a server-side close returns the same working reference', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  const again = await client.getProject(projectId)
  assert.equal(again, project, 'project references are permanent')
  await again.$getProjectSettings()
})

test('Nested-namespace calls also survive a server-side close', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })
  assert.ok(obs.docId)
})

test('A call in flight when the server closes the project still settles', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // Fire without awaiting, then close server-side. Whatever the outcome
  // (served by the dying instance or failed), the call must settle rather
  // than hang.
  const inFlight = project.$getProjectSettings()
  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  const result = await Promise.race([
    inFlight.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
  ])
  assert.equal(result, 'settled')
})

test('Closing one project server-side does not affect another', async (t) => {
  const { client, serverManager } = setup(t)
  const projectIdA = await client.createProject({ name: 'mapeo-a' })
  const projectIdB = await client.createProject({ name: 'mapeo-b' })

  const projectA = await client.getProject(projectIdA)
  const projectB = await client.getProject(projectIdB)
  await projectA.$getProjectSettings()
  await projectB.$getProjectSettings()

  const serverProjectA = await serverManager.getProject(projectIdA)
  await serverProjectA.close()

  const settingsB = await projectB.$getProjectSettings()
  assert.equal(settingsB.name, 'mapeo-b')
  assert.equal(
    serverManager.getProjectCallCount.get(projectIdB),
    1,
    'project B was never cycled',
  )

  const settingsA = await projectA.$getProjectSettings()
  assert.equal(settingsA.name, 'mapeo-a')
})

test('Two parallel getProject(id) calls return one wrapper and both work', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const [a, b] = await Promise.all([
    client.getProject(projectId),
    client.getProject(projectId),
  ])

  assert.equal(a, b, 'both callers should resolve to the same wrapper')
  await a.$getProjectSettings()
  await b.$getProjectSettings()
})

test('getProject for an already-acquired project makes no wire round trip', async (t) => {
  const { client, server } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // With the server gone, no round trip can be answered — only the cached
  // wrapper from the first acquisition can resolve this.
  server.close()
  const again = await client.getProject(projectId)
  assert.equal(again, project, 'cached wrapper returned without validation')
})

test('leaveProject: calls reject with ProjectLeftError and the gutted instance is closed', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // Core's leaveProject opens the project, guts it, and leaves the corpse
  // cached — observe the instance so we can assert the server closed it.
  const liveInstance = await serverManager.getProject(projectId)
  const closeObserved = pDefer()
  liveInstance.once('close', () => closeObserved.resolve(undefined))

  await client.leaveProject(projectId)
  await closeObserved.promise

  // Calls on the held reference reject: left projects are never
  // transparently re-opened. `getProject` itself still resolves — the
  // wrapper was cached at first acquisition, and re-validating it would
  // cost a round trip — but every call on it rejects the same way.
  await assert.rejects(() => project.$getProjectSettings(), {
    code: ProjectLeftError.code,
  })
  const again = await client.getProject(projectId)
  assert.equal(again, project, 'project references are permanent')
  await assert.rejects(() => again.$getProjectSettings(), {
    code: ProjectLeftError.code,
  })
})

test('Re-joining after leave makes the same reference work again', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const liveInstance = await serverManager.getProject(projectId)
  const closeObserved = pDefer()
  liveInstance.once('close', () => closeObserved.resolve(undefined))
  await client.leaveProject(projectId)
  await closeObserved.promise

  await assert.rejects(() => project.$getProjectSettings(), {
    code: ProjectLeftError.code,
  })

  // Re-invite: core's addProject clears the left state (closing any stale
  // instance itself). The already-held reference simply works again.
  await serverManager.addProject(projectId)

  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('Left project without a prior reference: getProject rejects with ProjectLeftError', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  await client.leaveProject(projectId)

  await assert.rejects(() => client.getProject(projectId), {
    code: ProjectLeftError.code,
  })
})

// Cycling a project open/closed must not accumulate instances in the IPC
// layer's bookkeeping. The fake manager releases its instance on close, so
// any instance still reachable after a cycle is being retained by the IPC
// layer itself (the host detaches rpc-reflector's handler when the instance
// closes; the subscription registry holds no instance references).
//
// Runs only when `global.gc` is available (npm test passes --expose-gc).
test('Repeated server-side close/re-open cycles do not retain prior instances', async (t) => {
  if (typeof global.gc !== 'function') {
    t.skip('Run with --expose-gc to verify cycle retention')
    return
  }

  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  // Keep a live subscription across every cycle so the tape path is
  // exercised while the WeakRefs are collected.
  project.on('some-event', () => {})

  const N = 5
  /** @type {Array<WeakRef<object>>} */
  const refs = []
  for (let i = 0; i < N; i++) {
    refs.push(await cycleAndCaptureWeakRef())
  }

  // In a helper so the instance local goes out of scope before GC runs —
  // the loop frame would otherwise pin the final cycle's instance.
  /** @returns {Promise<WeakRef<object>>} */
  async function cycleAndCaptureWeakRef() {
    await project.$getProjectSettings()
    const serverProject = await serverManager.getProject(projectId)
    const ref = new WeakRef(serverProject)
    await serverProject.close()
    return ref
  }

  for (let i = 0; i < 20; i++) {
    global.gc()
    await new Promise((resolve) => setImmediate(resolve))
  }

  const survivors = refs.filter((ref) => ref.deref() !== undefined).length
  assert.equal(
    survivors,
    0,
    `${survivors} of ${N} closed instances retained — expected 0. A non-zero count means IPC is accumulating closed instances cycle over cycle.`,
  )
})

test('After a failed getProject, a subsequent getProject for a real project succeeds', async (t) => {
  const { client } = setup(t)

  await assert.rejects(() => client.getProject('does-not-exist'), {
    code: NotFoundError.code,
  })

  const realId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(realId)
  await project.$getProjectSettings()

  // And a retry of the original failing id still rejects (project still
  // doesn't exist) — proving the failure path itself is retried, not
  // returned from a poisoned cache.
  await assert.rejects(() => client.getProject('does-not-exist'), {
    code: NotFoundError.code,
  })
})

test('Method calls on a never-validated reference to an unknown project reject', async (t) => {
  const { client, port2 } = setup(t)

  // Bypass getProject's existence check by writing a request frame straight
  // onto an unknown project's channel — this is what a desynced or misbehaving
  // client would produce. The server must answer with a per-request error
  // response (the handler factory's rejection), not leave the call to time
  // out.
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const channelId = '@@comapeo/project/no-such-project'
  /** @type {any[]} */
  const responses = []
  /** @param {any} event */
  const captureResponse = (event) => {
    if (event.data?.id === channelId) responses.push(event.data.message)
  }
  port2.addEventListener('message', captureResponse)
  t.after(() => port2.removeEventListener('message', captureResponse))

  // REQUEST frame: [msgType.REQUEST = 0, msgId, propArray, args]
  port2.postMessage({
    id: channelId,
    message: [0, 99, ['$getProjectSettings'], []],
  })

  await waitFor(
    () => responses.length > 0,
    'an error response on the unknown project channel',
  )
  const [response] = responses
  assert.equal(response[0], 1, 'RESPONSE frame (msgType.RESPONSE)')
  assert.equal(response[1], 99, 'answers the request msgId')
  assert.equal(
    response[2]?.code,
    NotFoundError.code,
    'carries the factory rejection, code preserved',
  )

  // And the server stays healthy afterwards.
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

// The project channel's rpc handler is bound late to whichever instance is
// live, so a bad method path is resolved against the instance at call time.
// It must fail the same way it did when the instance was bound statically.
test('Calling a method that does not exist rejects with a ReferenceError', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await assert.rejects(
    // @ts-expect-error deliberately absent from the API
    () => project.notAMethod(),
    { name: 'ReferenceError', message: /notAMethod is not defined/ },
  )
  await assert.rejects(
    // @ts-expect-error deliberately absent from the API
    () => project.observation.notAMethod(),
    { name: 'ReferenceError', message: /notAMethod is not defined/ },
  )
  await assert.rejects(
    // @ts-expect-error deliberately absent from the API
    () => project.noSuchNamespace.create(),
    { name: 'ReferenceError', message: /noSuchNamespace is not defined/ },
  )

  // The project is still healthy afterwards.
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('Concurrent calls to a dormant project open the instance exactly once', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  const before = serverManager.getProjectCallCount.get(projectId)
  await Promise.all([
    project.$getProjectSettings(),
    project.$getProjectSettings(),
    project.observation.create({
      schemaName: 'observation',
      attachments: [],
      tags: {},
    }),
  ])

  assert.equal(
    serverManager.getProjectCallCount.get(projectId),
    (before ?? 0) + 1,
    'concurrent calls share a single open',
  )
})

test('project.close is not exposed on the client surface', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  assert.equal(
    // @ts-expect-error close is deliberately absent from the typed surface
    project.close,
    undefined,
    'lifecycle is server-owned; the client cannot close a project',
  )
})

test('A leave that races an in-flight open still rejects with ProjectLeftError', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Hold the factory's `manager.getProject` open so a leave can land between
  // the factory's first left check and the instance resolving — the window
  // core's leaveProject keeps open for up to its sync wait.
  const gate = pDefer()
  const factoryBlocked = pDefer()
  const originalGetProject = manager.getProject.bind(manager)
  let intercepted = false
  manager.getProject = async (id) => {
    if (!intercepted) {
      intercepted = true
      factoryBlocked.resolve(undefined)
      await gate.promise
    }
    return originalGetProject(id)
  }

  const acquiring = client.getProject(projectId)
  await factoryBlocked.promise
  await manager.leaveProject(projectId)
  gate.resolve(undefined)

  // Without the post-open re-check the factory would bind the gutted
  // instance and the call would resolve with garbage.
  await assert.rejects(() => acquiring, { code: ProjectLeftError.code })
})

test("Core's double close emit is harmless to the host", async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  /** @type {unknown[]} */
  const received = []
  project.on('some-event', (value) => received.push(value))
  await project.$getProjectSettings()

  const instance = await serverManager.getProject(projectId)
  let closeEmits = 0
  instance.on('close', () => closeEmits++)
  await instance.close()
  assert.equal(closeEmits, 2, 'fake models core: close is emitted twice')

  // A stray extra emit after close must also be harmless (detach is
  // idempotent and the host's once() is already consumed).
  instance.emit('close')

  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  const fresh = await serverManager.getProject(projectId)
  fresh.emit('some-event', 'after-reopen')
  await project.$getProjectSettings()
  assert.deepEqual(received, ['after-reopen'], 'subscriptions survived')
})

test('Opening while an instance close is in flight waits it out and binds the fresh instance', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Open server-side only, then start a close held open by a gate: `closing`
  // is set, `closed` is not, and the manager cache still returns the dying
  // instance (core evicts only on the `close` event).
  const dying = await manager.getProject(projectId)
  const gate = pDefer()
  dying.holdClose(gate.promise)
  const closing = dying.close()

  // First acquisition arrives mid-close: the host must wait the close out
  // and retry, not bind the corpse.
  const acquiring = client.getProject(projectId)
  await waitFor(
    () => (manager.getProjectCallCount.get(projectId) ?? 0) >= 2,
    'the factory to observe the dying instance',
  )
  gate.resolve(undefined)
  await closing

  const project = await acquiring
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  const fresh = await manager.getProject(projectId)
  assert.notEqual(fresh, dying, 'bound instance is the post-close one')
  assert.equal(fresh.closed, false)
  assert.equal(
    manager.getProjectCallCount.get(projectId),
    4,
    'test open + dying observation + retry + this getProject',
  )
})

test('Gives up after the project keeps closing while opening', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Every open observes an instance whose close is already in flight — a
  // pathological resource policy closing projects as fast as they open.
  const originalGetProject = manager.getProject.bind(manager)
  manager.getProject = async (id) => {
    const project = await originalGetProject(id)
    project.close()
    return project
  }

  await assert.rejects(() => client.getProject(projectId), {
    message: /kept closing while opening/,
  })
})

test('Re-invite after leaving a never-acquired project: getProject succeeds', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  await client.leaveProject(projectId)
  await assert.rejects(() => client.getProject(projectId), {
    code: ProjectLeftError.code,
  })

  // Re-invite: nothing was cached for this id (the failed acquisition is not
  // cached either), so the next getProject validates afresh and succeeds.
  await manager.addProject(projectId)
  const project = await client.getProject(projectId)
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('Parallel first getProject calls make exactly one validation round trip', async (t) => {
  const { port1, port2 } = new MessageChannel()
  const manager = new FakeManager()
  let assertCalls = 0
  const server = createComapeoCoreServer(/** @type {any} */ (manager), port1, {
    onRequestHook: (request, next) => {
      if (request.method.join('.') === 'assertProjectExists') assertCalls++
      next(request)
    },
  })
  const client = createComapeoCoreClient(port2)
  port1.start()
  port2.start()
  t.after(async () => {
    server.close()
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  const projectId = await client.createProject({ name: 'mapeo' })
  const [a, b, c] = await Promise.all([
    client.getProject(projectId),
    client.getProject(projectId),
    client.getProject(projectId),
  ])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(assertCalls, 1, 'concurrent first calls share one round trip')

  await client.getProject(projectId)
  assert.equal(assertCalls, 1, 'cached wrapper: no further round trips')
})

test('A consumer onRequestHook composes with the interim leave hook', async (t) => {
  const { port1, port2 } = new MessageChannel()
  const manager = new FakeManager()
  /** @type {string[]} */
  const hookedMethods = []
  const server = createComapeoCoreServer(/** @type {any} */ (manager), port1, {
    onRequestHook: (request, next) => {
      hookedMethods.push(request.method.join('.'))
      next(request)
    },
  })
  const client = createComapeoCoreClient(port2)
  port1.start()
  port2.start()
  t.after(async () => {
    server.close()
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  const liveInstance = await manager.getProject(projectId)
  const closeObserved = pDefer()
  liveInstance.once('close', () => closeObserved.resolve(undefined))

  await client.leaveProject(projectId)
  // The interim leave hook still ran under the consumer hook: the gutted
  // instance gets closed.
  await closeObserved.promise

  assert.ok(
    hookedMethods.includes('createProject'),
    'consumer hook saw manager calls',
  )
  assert.ok(
    hookedMethods.includes('leaveProject'),
    'consumer hook saw the leave',
  )
  await assert.rejects(() => project.$getProjectSettings(), {
    code: ProjectLeftError.code,
  })
})

test('A failed leaveProject still closes the opened instance', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Leave fails after opening the instance (mirrors core: leave can fail
  // mid-way, after `getProject`); the cleanup close must run regardless.
  manager.leaveProject = async (id) => {
    await manager.getProject(id)
    throw new Error('leave failed mid-way')
  }

  const instance = await manager.getProject(projectId)
  const closeObserved = pDefer()
  instance.once('close', () => closeObserved.resolve(undefined))

  await assert.rejects(() => client.leaveProject(projectId), {
    message: /leave failed mid-way/,
  })
  await closeObserved.promise

  // The project was never actually left, so it simply re-opens and works.
  const project = await client.getProject(projectId)
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})
