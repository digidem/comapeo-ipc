import test from 'node:test'
import assert from 'node:assert/strict'

import { setup } from './helpers.js'

test('After close, methods on the closed reference reject', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Sanity: methods work pre-close.
  await project.$getProjectSettings()

  await project.close()

  await assert.rejects(() => project.$getProjectSettings(), /Project is closed/)
})

test('After close, nested-namespace methods on the closed reference reject', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Pre-close: nested namespace works.
  await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  await project.close()

  await assert.rejects(
    () =>
      project.observation.create({
        schemaName: 'observation',
        attachments: [],
        tags: {},
      }),
    /Project is closed/,
  )
})

test('After close, observations created earlier are still readable via a re-opened reference', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  await project.close()

  const reopened = await client.getProject(projectId)
  assert.notEqual(
    reopened,
    project,
    're-opened reference should be a fresh wrapper',
  )

  const fetched = await reopened.observation.getByDocId(obs.docId)
  assert.equal(fetched.docId, obs.docId)
})

// The architectural reason this PR exists. After close + re-open, a stale
// call posted through the OLD wrapper must NOT silently land on the freshly
// re-opened project — it must reject. (This is the failure mode the bug
// report flagged: silent re-open, with the additional risk that a concurrent
// `getProject(id)` could have re-opened the project between the close and
// the late call.)
test('After close + re-open, a stale call on the old reference still rejects', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const oldProject = await client.getProject(projectId)
  await oldProject.$getProjectSettings()
  await oldProject.close()

  const newProject = await client.getProject(projectId)
  await newProject.$getProjectSettings()

  await assert.rejects(
    () => oldProject.$getProjectSettings(),
    /Project is closed/,
  )
})

test('Two parallel getProject(id) calls return one wrapper and both work', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  // Drive parallel `getProject(id)` calls from a freshly-cleared cache by
  // closing the project first, so both calls go all the way to the server.
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

  // A is closed; B is unaffected.
  await assert.rejects(
    () => projectA.$getProjectSettings(),
    /Project is closed/,
  )
  const settingsB = await projectB.$getProjectSettings()
  assert.equal(settingsB.name, 'mapeo-b')
})

test('When the server closes the project, client calls on the wrapper reject', async (t) => {
  const { client, serverManager } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  await project.$getProjectSettings()

  // Close the project from the server side, bypassing the client. The
  // wrapper has no idea this happened until it tries a method call.
  const serverProject = await serverManager.getProject(projectId)
  await serverProject.close()

  await assert.rejects(() => project.$getProjectSettings(), /Project is closed/)
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

test('After a failed getProject, a subsequent getProject for a real project succeeds', async (t) => {
  const { client } = setup(t)

  // Different ids: first fails (project does not exist), then a real
  // project is created and getProject(realId) must succeed. Without the
  // cache-poisoning fix, a rejected entry could linger and break unrelated
  // ids; with it, only the failed id's entry is evicted.
  await assert.rejects(() => client.getProject('does-not-exist'), /not found/i)

  const realId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(realId)
  await project.$getProjectSettings()

  // And a retry of the original failing id still rejects (project still
  // doesn't exist) — proving the failure path itself is also retried, not
  // returned from a poisoned cache.
  await assert.rejects(() => client.getProject('does-not-exist'), /not found/i)
})
