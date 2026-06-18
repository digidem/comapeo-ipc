import test from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '@comapeo/core/errors.js'

import { ClientClosedError, RpcChannelClosedError } from '../src/errors.js'
import { closeMapeoClient } from '../src/client.js'

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

test('Client calls fail after server closes', async (t) => {
  const { client, server } = setup(t)

  const projectId = await client.createProject({ name: 'mapeo' })
  const projectBefore = await client.getProject(projectId)

  await projectBefore.$getProjectSettings()

  server.close()
  await closeMapeoClient(client)

  // After close, getProject rejects uniformly with ClientClosedError — both
  // for a project fetched earlier (cached) and for one never fetched.
  await assert.rejects(() => client.getProject(projectId), {
    code: ClientClosedError.code,
  })
  await assert.rejects(() => client.getProject('never-fetched'), {
    code: ClientClosedError.code,
  })

  // Method calls on the client and on a previously-obtained project reference
  // also reject with ClientClosedError.
  const results = await Promise.allSettled([
    client.listProjects(),
    projectBefore.$getProjectSettings(),
  ])

  for (const result of results) {
    assert.equal(
      result.status,
      'rejected',
      // @ts-ignore
      result.reason,
    )
    assert.equal(
      // @ts-ignore
      result.reason.code,
      ClientClosedError.code,
      'after the client is closed, calls reject with ClientClosedError',
    )
  }
})

test('In-flight calls reject with RpcChannelClosedError when the client closes', async (t) => {
  const { client } = setup(t)

  // Fire a call but don't await it, then close the client synchronously before
  // the response can arrive. The call was already on the wire, so it isn't
  // re-routed through the closed-proxy (which would give ClientClosedError) —
  // it rejects with the underlying channel-closed error as the channel tears
  // down. This is the behaviour the README documents for in-flight calls.
  const inFlight = client.listProjects()
  const closing = closeMapeoClient(client)

  await assert.rejects(inFlight, { code: RpcChannelClosedError.code })
  await closing
})
