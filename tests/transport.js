import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
} from '../src/client.js'
import { createComapeoCoreServer } from '../src/server.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

test('Malformed and unroutable messages are ignored and the client keeps working', async (t) => {
  const { client, port2 } = setup(t)

  // A prefixed-but-unroutable id is logged via console.error; foreign and
  // malformed messages should produce no log at all, so capture both streams.
  /** @type {string[]} */
  const logs = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (/** @type {unknown[]} */ ...args) => {
    logs.push(String(args[0]))
  }
  console.error = (/** @type {unknown[]} */ ...args) => {
    logs.push(String(args[0]))
  }
  t.after(() => {
    console.warn = originalWarn
    console.error = originalError
  })

  // Posting on port2 delivers to the server's port. None of these should throw
  // or wedge the server.
  port2.postMessage('garbage')
  port2.postMessage(42)
  port2.postMessage(null)
  port2.postMessage({ no: 'id or message' })
  // Well-formed envelope without our channel prefix: a foreign sender sharing
  // the port. Dropped silently — not our traffic, so no warning.
  port2.postMessage({ id: 'someone-elses-channel', message: { value: 'x' } })
  // Well-formed envelope carrying our prefix but for an instance id the server
  // never opened — a genuine routing miss. Posted twice to exercise the
  // warn-once dedupe.
  const unknownId = '@@comapeo/project/project-999:42'
  port2.postMessage({ id: unknownId, message: { value: 'whatever' } })
  port2.postMessage({ id: unknownId, message: { value: 'whatever' } })

  // Let the messages flush through the event loop.
  await new Promise((resolve) => setImmediate(resolve))

  const projectId = await client.createProject({ name: 'mapeo' })
  assert.ok(projectId)
  const project = await client.getProject(projectId)
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  // The prefixed-but-unroutable id is logged exactly once (deduped).
  const unrecognised = logs.filter((w) => w.includes('project-999:42'))
  assert.equal(unrecognised.length, 1)
  // The foreign (unprefixed) envelope and the structurally-invalid messages
  // are dropped without any log.
  const foreign = logs.filter((w) => w.includes('someone-elses-channel'))
  assert.equal(foreign.length, 0)
})

test('createComapeoCoreServer().close() is idempotent', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const server = createComapeoCoreServer(
    /** @type {any} */ (new FakeManager()),
    port1,
  )
  const client = createComapeoCoreClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    await closeComapeoCoreClient(client)
    port1.close()
    port2.close()
  })

  // Sanity: server works before close.
  const projectId = await client.createProject({ name: 'mapeo' })
  assert.ok(projectId)

  // Repeated closes must not throw.
  server.close()
  server.close()
})
