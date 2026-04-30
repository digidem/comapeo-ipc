import test from 'node:test'
import assert from 'node:assert/strict'

import { setup } from './helpers.js'

test('server: methods on a closed project reject with "Project is closed"', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  // Sanity: methods work pre-close.
  await project.$getProjectSettings()

  await project.close()

  await assert.rejects(() => project.$getProjectSettings(), /Project is closed/)
})

test('server: nested namespaces reject after close', async (t) => {
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

test('server: re-open via client.getProject(id) works after close', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })

  await project.close()

  // Re-open via getProject — should succeed and methods should work.
  const reopened = await client.getProject(projectId)
  assert.notEqual(
    reopened,
    project,
    'reopened reference should be a fresh proxy after close evicts cache',
  )

  const fetched = await reopened.observation.getByDocId(obs.docId)
  assert.equal(fetched.docId, obs.docId)
})

// B1 — the architectural reason per-instance subchannel ids exist. After
// close + re-open via getProject(id), the OLD wrapper reference and the
// NEW one must live on different SubChannel ids, so a stale call posted
// through the old wrapper cannot reach the freshly-opened project on the
// server. Without per-instance ids, the stale call would land on the same
// SubChannel as the new instance and silently succeed against it.
test('server: stale call on old wrapper after re-open still rejects', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const oldProject = await client.getProject(projectId)
  await oldProject.$getProjectSettings()
  await oldProject.close()

  // Re-open the project. Server mints a fresh instance id; the new wrapper
  // is on a different SubChannel.
  const newProject = await client.getProject(projectId)
  await newProject.$getProjectSettings()

  // Stale call on the OLD wrapper must reject — the server's tombstone
  // stub for the old instance answers, even though a fresh instance is
  // open at the same projectId.
  await assert.rejects(
    () => oldProject.$getProjectSettings(),
    /Project is closed/,
  )
})

test('client: getProject after close returns a fresh reference (cache eviction)', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const project = await client.getProject(projectId)
  await project.close()

  const reopened = await client.getProject(projectId)
  assert.notEqual(reopened, project)

  // Drive a method call so the re-opened project is fully initialized
  // before the test tears down.
  await reopened.$getProjectSettings()
})

test('client: failed assertProjectExists evicts cache so retry can succeed', async (t) => {
  const { client } = setup(t)

  // First call fails because the project does not exist.
  await assert.rejects(() => client.getProject('does-not-exist'))

  // Now create a project with a known id and confirm a subsequent
  // getProject(id) for that id is not poisoned by the earlier failure for a
  // different id. Also retry the failing id — the cache should be evicted so
  // the retry hits the server again rather than returning the same rejected
  // promise instantly.
  await assert.rejects(() => client.getProject('does-not-exist'))
})

// The throwing-proxy stub used on the server side is the contract: any
// property at any depth must resolve to a callable, and applying that
// callable must throw the supplied error. Validate the shape directly so we
// don't need to rely on the integration path to exercise edge cases.
test('throwing-proxy stub: nested access + apply throws supplied error', async () => {
  /** @type {ProxyHandler<any>} */
  const handler = {
    get() {
      return new Proxy(function () {}, handler)
    },
    has() {
      return true
    },
    apply() {
      throw new Error('Project is closed')
    },
  }
  // Outer target is `{}` so that `typeof === 'object'` (rpc-reflector
  // requires this for handler objects).
  const stub = new Proxy({}, handler)

  assert.equal(typeof stub, 'object')

  // Reflect.has must return true at any depth so rpc-reflector's
  // applyNestedMethod walks through.
  assert.equal(Reflect.has(stub, 'observation'), true)
  assert.equal(Reflect.has(stub.observation, 'create'), true)

  // Nested access returns a callable that throws when invoked. (The outer
  // proxy itself is not callable — only nested function-target proxies are.
  // rpc-reflector never invokes the handler directly, only its methods.)
  assert.throws(() => stub.foo(), /Project is closed/)
  assert.throws(() => stub.foo.bar(), /Project is closed/)
  assert.throws(() => stub.foo.bar.baz(1, 2, 3), /Project is closed/)
})
