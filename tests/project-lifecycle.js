import test from 'node:test'
import assert from 'node:assert/strict'
import pDefer from 'p-defer'
import { NotFoundError } from '@comapeo/core/errors.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'
import { ProjectLeftError } from '../src/errors.js'

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

  // Both the cached reference and a fresh getProject reject: left projects
  // are never transparently re-opened.
  await assert.rejects(() => project.$getProjectSettings(), {
    code: ProjectLeftError.code,
  })
  await assert.rejects(() => client.getProject(projectId), {
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
// layer itself (the host must drop its server + project references when the
// instance closes; the subscription tape holds no instance references).
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
  // client would produce. The server must answer with an error response (via
  // its transient stub), not leave the call to time out.
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // REQUEST frame: [msgType.REQUEST = 0, msgId, propArray, args]
  port2.postMessage({
    id: '@@comapeo/project/no-such-project',
    message: [0, 1, ['$getProjectSettings'], []],
  })

  // The response goes to a channel no local client listens on; all we can
  // assert from here is that the server stays healthy afterwards.
  await new Promise((resolve) => setImmediate(resolve))
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

// The project channel's rpc handler is a facade that delegates to whichever
// instance is live, so a bad method path is resolved against the instance at
// call time. It must fail the same way it did when the instance itself was
// the handler.
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
