import test from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '@comapeo/core/errors.js'

import {
  ClientClosedError,
  RpcChannelClosedError,
  RpcTimeoutError,
} from '../src/errors.js'
import {
  closeComapeoCoreClient,
  createComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

test('IPC wrappers work', async (t) => {
  const { client } = setup(t)

  const projectId = await client.createProject({ name: 'mapeo' })

  assert.ok(projectId)

  const project = await client.getProject(projectId)

  assert.ok(project)

  const projectSettings = await project.$getProjectSettings()

  assert.deepEqual(projectSettings, {
    name: 'mapeo',
    configMetadata: undefined,
    defaultPresets: undefined,
    projectColor: undefined,
    projectDescription: undefined,
    sendStats: false,
  })

  const isArchiveDevice = await client.getIsArchiveDevice()

  assert.ok(isArchiveDevice)
})

test('Get project calls deduplicated', async (t) => {
  const { client } = setup(t)

  const projectId = await client.createProject({ name: 'mapeo' })

  assert.ok(projectId)

  const project = await client.getProject(projectId)

  assert.ok(project)

  const project2 = await client.getProject(projectId)

  assert.ok(project2)

  assert.equal(project2, project)
})

test('Concurrent getProject opens the project on the server only once', async (t) => {
  const manager = new FakeManager()
  const { client } = setup(t, manager)

  const projectId = await client.createProject({ name: 'mapeo' })

  // Several concurrent first-time getProject(id) calls must collapse into a
  // single server-side open — not N separate `manager.getProject` calls that
  // would mint duplicate subchannels.
  await Promise.all([
    client.getProject(projectId),
    client.getProject(projectId),
    client.getProject(projectId),
  ])

  assert.equal(manager.getProjectCallCount.get(projectId), 1)
})

test('Multiple projects and several calls in same tick', async (t) => {
  const { client } = setup(t)

  const sample = Array(10)
    .fill(null)
    .map((_, index) => {
      return {
        name: `Mapeo ${index}`,
        configMetadata: undefined,
        defaultPresets: undefined,
        projectColor: undefined,
        projectDescription: undefined,
      }
    })

  const projectIds = await Promise.all(
    sample.map(async (s) => client.createProject(s)),
  )

  const projects = await Promise.all(
    projectIds.map((id) => client.getProject(id)),
  )

  const settings = await Promise.all(
    projects.map((project) => project.$getProjectSettings()),
  )

  const listedProjects = await client.listProjects()

  assert.equal(projectIds.length, sample.length)
  assert.equal(projects.length, sample.length)
  assert.equal(settings.length, sample.length)
  assert.equal(listedProjects.length, sample.length)

  settings.forEach((s, index) => {
    const expectedSettings = sample[index]
    assert.deepEqual(s, { ...expectedSettings, sendStats: false })
  })
})

test('Attempting to get non-existent project fails', async (t) => {
  const { client } = setup(t)

  await assert.rejects(
    async () => {
      await client.getProject('mapeo')
    },
    { code: NotFoundError.code },
  )

  const results = await Promise.allSettled([
    client.getProject('mapeo'),
    client.getProject('mapeo'),
  ])

  assert.deepEqual(
    results.map(({ status }) => status),
    ['rejected', 'rejected'],
  )
})

test('Calls fail with ClientClosedError after the client closes', async (t) => {
  const { client, server } = setup(t)

  const projectId = await client.createProject({ name: 'mapeo' })
  const projectBefore = await client.getProject(projectId)

  await projectBefore.$getProjectSettings()

  server.close()
  await closeComapeoCoreClient(client)

  // After close, getProject rejects uniformly with ClientClosedError — both
  // for a project fetched earlier (cached) and for one never fetched.
  await assert.rejects(() => client.getProject(projectId), {
    code: ClientClosedError.code,
  })
  await assert.rejects(() => client.getProject('never-fetched'), {
    code: ClientClosedError.code,
  })

  // Manager calls reject with ClientClosedError (the manager proxy maps
  // post-close calls to it).
  await assert.rejects(() => client.listProjects(), {
    code: ClientClosedError.code,
  })

  // A previously-obtained project reference is left to its own (now-closed)
  // subchannel, so its calls reject with the underlying channel-closed error
  // rather than ClientClosedError.
  await assert.rejects(() => projectBefore.$getProjectSettings(), {
    code: RpcChannelClosedError.code,
  })
})

test('Project method errors propagate with their code', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)

  await assert.rejects(() => project.observation.getByDocId('nope'), {
    code: NotFoundError.code,
  })
})

test('Client close waits for an in-flight getProject, then rejects further calls', async (t) => {
  const { client } = setup(t)
  const projectId = await client.createProject({ name: 'mapeo' })

  const opening = client.getProject(projectId)
  const closing = closeComapeoCoreClient(client)

  const project = await opening
  assert.ok(project)
  await closing

  await assert.rejects(() => project.$getProjectSettings(), {
    code: RpcChannelClosedError.code,
  })
  await assert.rejects(() => client.getProject(projectId), {
    code: ClientClosedError.code,
  })
})

test('In-flight calls reject with RpcChannelClosedError when the client closes', async (t) => {
  const { client } = setup(t)

  // Fire a call but don't await it, then close the client synchronously before
  // the response can arrive. The call was already on the wire, so it isn't
  // re-routed through the closed-proxy (which would give ClientClosedError) —
  // it rejects with the underlying channel-closed error as the channel tears
  // down. This is the behaviour the README documents for in-flight calls.
  const inFlight = client.listProjects()
  const closing = closeComapeoCoreClient(client)

  await assert.rejects(inFlight, { code: RpcChannelClosedError.code })
  await closing
})

test('Calls time out after the server closes', async (t) => {
  const { port1, port2 } = new MessageChannel()
  const server = createComapeoCoreServer(
    /** @type {any} */ (new FakeManager()),
    port1,
  )
  const client = createComapeoCoreClient(port2, { timeout: 50 })
  port1.start()
  port2.start()
  t.after(async () => {
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  const projectId = await client.createProject({ name: 'mapeo' })
  const project = await client.getProject(projectId)
  server.close()

  const expected = { code: RpcTimeoutError.code }
  await assert.rejects(() => client.listProjects(), expected)
  await assert.rejects(() => project.$getProjectSettings(), expected)
  await assert.rejects(() => client.getProject('other'), expected)
})
