import { MessageChannel } from 'node:worker_threads'
import RAM from 'random-access-memory'
import { KeyManager } from '@mapeo/crypto'
import { MapeoManager } from '@comapeo/core'
import { createRequire } from 'node:module'
import path from 'node:path'
import Fastify from 'fastify'
import os from 'node:os'
import fs from 'node:fs'

import { createMapeoClient, closeMapeoClient } from '../src/client.js'
import { createMapeoServer } from '../src/server.js'

const require = createRequire(import.meta.url)

const COMAPEO_CORE_PKG_FOLDER = path.dirname(
  require.resolve('@comapeo/core/package.json'),
)
const projectMigrationsFolder = path.join(
  COMAPEO_CORE_PKG_FOLDER,
  'drizzle/project',
)
const clientMigrationsFolder = path.join(
  COMAPEO_CORE_PKG_FOLDER,
  'drizzle/client',
)

/** @param {import('node:test').TestContext} t */
export function setup(t) {
  const { port1, port2 } = new MessageChannel()
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapeo-ipc-test-'))
  const coreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapeo-ipc-core-'))

  const manager = new MapeoManager({
    rootKey: KeyManager.generateRootKey(),
    dbFolder: dbDir,
    coreStorage: coreDir,
    projectMigrationsFolder,
    clientMigrationsFolder,
    fastify: Fastify(),
  })

  const server = createMapeoServer(manager, port1)
  const client = createMapeoClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    server.close()
    await closeMapeoClient(client)
    fs.rmSync(dbDir, { recursive: true, force: true })
    fs.rmSync(coreDir, { recursive: true, force: true })
    port1.close()
    port2.close()
  })

  return {
    port1,
    port2,
    server,
    client,
    serverManager: manager,
  }
}
