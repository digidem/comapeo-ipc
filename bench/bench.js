// @ts-check

import bench from 'nanobench'
import assert from 'node:assert/strict'
import { setup } from '../tests/helpers.js'

const GET_PROJECT_COUNT = 1_000_000

bench(`fetching ${GET_PROJECT_COUNT} projects`, async (b) => {
  const { client, cleanup } = setup()

  const projectId = await client.createProject()

  b.start()

  const projects = await Promise.all(
    new Array(GET_PROJECT_COUNT)
      .fill(null)
      .map(() => client.getProject(projectId)),
  )

  b.end()

  await cleanup()

  const [firstProject] = projects
  projects.forEach((project) => {
    assert.equal(project, firstProject)
  })
})
