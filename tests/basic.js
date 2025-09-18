import test from 'node:test'
import assert from 'node:assert/strict'

import { closeMapeoClient } from '../src/client.js'

import { setup } from './helpers.js'

test('IPC wrappers work', async () => {
  const { client, cleanup } = setup()

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

  return cleanup()
})

test('Multiple projects and several calls in same tick', async () => {
  const { client, cleanup } = setup()

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

  return cleanup()
})

test('Attempting to get non-existent project fails', async () => {
  const { client, cleanup } = setup()

  await assert.rejects(async () => {
    await client.getProject('mapeo')
  })

  const results = await Promise.allSettled([
    client.getProject('mapeo'),
    client.getProject('mapeo'),
  ])

  assert.deepEqual(
    results.map(({ status }) => status),
    ['rejected', 'rejected'],
  )

  return cleanup()
})

test('Concurrent calls that succeed', async () => {
  const { client, cleanup } = setup()

  const projectId = await client.createProject()

  const [project1, project2] = await Promise.all([
    client.getProject(projectId),
    client.getProject(projectId),
  ])

  assert.equal(project1, project2)

  return cleanup()
})

test('Client calls fail after server closes', async () => {
  const { client, server, cleanup } = setup()

  const projectId = await client.createProject({ name: 'mapeo' })
  const projectBefore = await client.getProject(projectId)

  await projectBefore.$getProjectSettings()

  server.close()
  await closeMapeoClient(client)

  const projectAfter = await client.getProject(projectId)

  // Even after server closes we're still able to get the project ipc instance, which is okay
  // because any field access should fail on that, rendering it unusable
  // Adding this assertion to track changes in this behavior
  assert.ok(projectAfter)

  // Doing it this way to speed up the test because each should wait for a timeout
  // Attempting to access any fields on the ipc instances should fail (aside from client.getProject, which is tested above)
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
  }

  return cleanup()
})
