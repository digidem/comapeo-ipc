import { MessageChannel } from 'node:worker_threads'
import RAM from 'random-access-memory'
import { KeyManager } from '@mapeo/crypto'
import { MapeoManager } from '@comapeo/core'
import { createRequire } from 'node:module'
import path from 'node:path'
import Fastify from 'fastify'

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

export function makeManager() {
  const manager = new MapeoManager({
    rootKey: KeyManager.generateRootKey(),
    dbFolder: ':memory:',
    coreStorage: () => new RAM(),
    projectMigrationsFolder,
    clientMigrationsFolder,
    fastify: Fastify(),
  })

  return manager
}

export function setup() {
  const { port1, port2 } = new MessageChannel()

  const manager = makeManager()

  const server = createMapeoServer(manager, port1)
  const client = createMapeoClient(port2)

  port1.start()
  port2.start()

  return {
    port1,
    port2,
    server,
    client,
    cleanup: async () => {
      server.close()
      await closeMapeoClient(client)
      port1.close()
      port2.close()
    },
  }
}
