import test from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '@comapeo/core/errors.js'

import { setup } from './helpers.js'

// A project's `close()` is remote-only: the subchannel stays open, so the next
// call transparently re-opens the project server-side and resolves. There is no
// per-project "closed" state on the client to reject against — the wrapper and
// its channel are kept for the life of the connection.

test('After close, a subsequent method call re-opens the project and resolves', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Sanity: methods work pre-close.
  await project.$getProjectSettings()

  await project.close()

  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('close() is idempotent — repeated calls resolve like the first', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await Promise.all([project.close(), project.close()])
  await project.close()

  // And the project can still be re-opened afterwards.
  const reopened = await client.getProject(projectId)
  await reopened.$getProjectSettings()
})

test('After close, observations created earlier are still readable via the same reference', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  await project.close()

  // The cache is never evicted, so getProject returns the same wrapper; the
  // server re-opens the project and the earlier observation is still there.
  const reopened = await client.getProject(projectId)
  assert.equal(reopened, project, 'getProject returns the cached wrapper')

  const fetched = await reopened.observation.getByDocId(obs.docId)
  assert.equal(fetched.docId, obs.docId)
})

test('Two parallel getProject(id) calls return one wrapper and both work', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Prime the cache, then close. The cache is never cleared on close, so both
  // parallel calls below resolve to the same cached wrapper.
  await (await client.getProject(projectId)).close()

  const [a, b] = await Promise.all([
    client.getProject(projectId),
    client.getProject(projectId),
  ])

  assert.equal(a, b, 'both callers should resolve to the same wrapper')
  await a.$getProjectSettings()
  await b.$getProjectSettings()
})

test('Closing one project does not affect another open project', async (t) => {
  const { client } = setup(t)
  const projectIdA = await client.createProject({ name: 'mapeo-a' })
  const projectIdB = await client.createProject({ name: 'mapeo-b' })

  const projectA = await client.getProject(projectIdA)
  const projectB = await client.getProject(projectIdB)

  await projectA.$getProjectSettings()
  await projectB.$getProjectSettings()

  await projectA.close()

  // Closing A is scoped to A's subchannel; B is unaffected. A re-opens
  // transparently on the next call.
  const settingsB = await projectB.$getProjectSettings()
  assert.equal(settingsB.name, 'mapeo-b')
  const settingsA = await projectA.$getProjectSettings()
  assert.equal(settingsA.name, 'mapeo-a')
})

// The next two tests pin recovery from a manager-initiated close — what
// `MapeoManager.addProject` does to a previously-left project when a
// re-invite is accepted (digidem/comapeo-mobile#2042). The cached client
// wrapper keeps working: the server re-opens the project on the next call.

test('After a manager-initiated close is observed, getProject returns a working instance', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Deliberately not node:events `once()`: its cleanup calls
  // `removeListener` on the wrapper after the close event.
  const closeObserved = new Promise((resolve) => {
    project.once('close', resolve)
  })
  // Round-trip so the 'close' subscription is registered server-side
  // (FIFO channel) before the close below emits.
  await project.$getProjectSettings()

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()
  await closeObserved

  const reOpened = await client.getProject(projectId)
  const settings = await reOpened.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
  assert.equal(reOpened, project, 'getProject returns the cached wrapper')
})

test('getProject returns a working instance immediately after a manager-initiated close', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  await client.getProject(projectId)

  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  // The close notification has not reached the client yet, so its cached
  // wrapper is reused. The server already knows the project is closed, so the
  // next method call re-opens it (see the hook in the server's live handler).
  const reOpened = await client.getProject(projectId)
  const settings = await reOpened.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')
})

test('A method call posted before close completes still resolves', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Fire the method without awaiting it, then close. The method's request
  // is posted to the server before the close request, so it should be
  // processed against the still-open project and resolve normally.
  const inFlight = project.$getProjectSettings()
  await project.close()

  const settings = await inFlight
  assert.equal(settings.name, 'mapeo')
})

// Repeatedly opening and closing the same project must not accumulate closed
// instances in IPC's per-project bookkeeping. The server's live handler
// retains only the most recent live instance (`state.current`), not one per
// open/close cycle, and the client keeps a single wrapper per project. So
// after N cycles at most the single most-recent instance is retained; one more
// live call moves it on and frees it.
//
// The fake manager releases its project instance on close (it holds no
// reference to a closed project), so any captured instance still reachable
// after a cycle is being retained by the IPC layer itself. We can therefore
// assert the strong invariant: after N cycles plus a final live call, zero of
// the captured (closed) instances survive.
//
// Runs only when `global.gc` is available (npm test passes --expose-gc).
test('Repeatedly opening and closing the same project does not retain prior instances', async (t) => {
  if (typeof global.gc !== 'function') {
    t.skip('Run with --expose-gc to verify cycle retention')
    return
  }

  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const N = 5
  /** @type {Array<WeakRef<object>>} */
  const refs = []
  for (let i = 0; i < N; i++) {
    refs.push(await cycleAndCaptureWeakRef())
  }

  /** @returns {Promise<WeakRef<object>>} */
  async function cycleAndCaptureWeakRef() {
    const project = await client.getProject(projectId)
    await project.$getProjectSettings()
    const serverProject = await serverManager.getProject(projectId)
    const ref = new WeakRef(serverProject)
    await project.close()
    return ref
  }

  // Release the most-recent instance the server's live handler is holding by
  // driving one more live call (which re-resolves to a fresh instance), so the
  // Nth captured instance becomes collectible too.
  const finalProject = await client.getProject(projectId)
  await finalProject.$getProjectSettings()

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

  // Different ids: first fails (project does not exist), then a real
  // project is created and getProject(realId) must succeed. A rejected
  // `getProject` is never cached, so the failure can't poison other ids.
  await assert.rejects(() => client.getProject('does-not-exist'), {
    code: NotFoundError.code,
  })

  const realId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(realId)
  await project.$getProjectSettings()

  // And a retry of the original failing id still rejects (project still
  // doesn't exist) — proving the failure path is retried, not returned from
  // a cached entry.
  await assert.rejects(() => client.getProject('does-not-exist'), {
    code: NotFoundError.code,
  })
})

// When the project is *deleted* (not just closed), `resolve()` in the
// server's `onRequestHook` rejects. The rejection must propagate to the
// client as the original error — not be swallowed and dispatched against
// the stale `state.current` instance (which would either silently succeed
// on freed data or throw a confusing TypeError).
test('Method call rejects with the server error when the project is deleted server-side', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // Delete the project entirely — not just close it.
  await serverManager.deleteProject(projectId)

  // The next method call should reject with the server's NotFoundError, not
  // silently succeed on a stale instance or reject with a TypeError.
  await assert.rejects(() => project.$getProjectSettings(), {
    code: NotFoundError.code,
  })
})

test('Concurrent method calls after a server-side close both re-open and resolve', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // Close the project from the server side so the next calls must re-open it.
  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  // Two concurrent method calls should both transparently re-open the project
  // and resolve — neither should dispatch against a stale instance.
  const [a, b] = await Promise.all([
    project.$getProjectSettings(),
    project.$getProjectSettings(),
  ])
  assert.equal(a.name, 'mapeo')
  assert.equal(b.name, 'mapeo')
})
