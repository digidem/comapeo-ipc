import { MessageChannel } from 'node:worker_threads'
import RAM from 'random-access-memory'
import { KeyManager } from '@mapeo/crypto'
import {
  MapeoManager,
  MapeoMapsFastifyPlugin,
  MapeoOfflineFallbackMapFastifyPlugin,
  MapeoStaticMapsFastifyPlugin,
} from '@comapeo/core'
import { createRequire } from 'node:module'
import path from 'node:path'
import Fastify from 'fastify'
import tmp from 'tmp'

tmp.setGracefulCleanup()

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

export function setup() {
  const { port1, port2 } = new MessageChannel()

  const manager = new MapeoManager({
    rootKey: KeyManager.generateRootKey(),
    dbFolder: ':memory:',
    coreStorage: () => new RAM(),
    projectMigrationsFolder,
    clientMigrationsFolder,
    fastify: createFastify(),
  })

  // Since v14.7.0, Node's MessagePort extends EventTarget (https://nodejs.org/api/worker_threads.html#class-messageport)
  // @ts-expect-error
  const server = createMapeoServer(manager, port1)
  // @ts-expect-error
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

// Just boilerplate needed for creating the MapeoManager instance - actual directories and whatnot don't matter for the tests here
function createFastify() {
  const tmpDir = tmp.dirSync()

  const fastify = Fastify()
  fastify.register(MapeoOfflineFallbackMapFastifyPlugin, {
    prefix: 'fallback',
    styleJsonPath: path.join(tmpDir.name, 'foo.json'),
    sourcesDir: path.join(tmpDir.name, 'bar'),
  })

  fastify.register(MapeoStaticMapsFastifyPlugin, {
    prefix: 'static',
    staticRootDir: path.resolve(tmpDir.name, 'baz'),
  })

  fastify.register(MapeoMapsFastifyPlugin, { prefix: 'maps' })

  return fastify
}
