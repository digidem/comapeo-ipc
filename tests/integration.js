import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { KeyManager } from '@mapeo/crypto'
import { MapeoManager } from '@comapeo/core'
import Fastify from 'fastify'

import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

const require = createRequire(import.meta.url)

const COMAPEO_CORE_PKG_FOLDER = path.dirname(
  path.dirname(require.resolve('@comapeo/core')),
)
const projectMigrationsFolder = path.join(
  COMAPEO_CORE_PKG_FOLDER,
  'drizzle/project',
)
const clientMigrationsFolder = path.join(
  COMAPEO_CORE_PKG_FOLDER,
  'drizzle/client',
)

// One end-to-end test against the real `@comapeo/core` MapeoManager. The rest
// of the suite runs against an in-memory fake (see fake-manager.js); this one
// proves the IPC wiring matches the real manager/project API shape and that
// real values round-trip over the channel.
test('end-to-end against a real MapeoManager', async (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comapeo-ipc-it-db-'))
  const coreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comapeo-ipc-it-core-'))

  const manager = new MapeoManager({
    rootKey: KeyManager.generateRootKey(),
    dbFolder: dbDir,
    coreStorage: coreDir,
    projectMigrationsFolder,
    clientMigrationsFolder,
    fastify: Fastify(),
  })

  const { port1, port2 } = new MessageChannel()
  const server = createComapeoCoreServer(manager, port1)
  const client = createComapeoCoreClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    server.close()
    await closeComapeoCoreClient(client)
    fs.rmSync(dbDir, { recursive: true, force: true })
    fs.rmSync(coreDir, { recursive: true, force: true })
    port1.close()
    port2.close()
  })

  // Manager methods round-trip.
  const projectId = await client.createProject({ name: 'mapeo' })
  assert.ok(projectId)

  const listed = await client.listProjects()
  assert.equal(listed.length, 1)

  // Per-project subchannel: settings, a nested-namespace write + read back,
  // then close.
  const project = await client.getProject(projectId)

  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  const obs = await project.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
  })
  const readBack = await project.observation.getByDocId(obs.docId)
  assert.equal(readBack.docId, obs.docId)

  await project.close()
})
