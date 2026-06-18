import test from 'node:test'
import assert from 'node:assert/strict'

import { createMapeoClient, closeMapeoClient } from '../src/client.js'
import { createMapeoServer } from '../src/server.js'

import { setup } from './helpers.js'
import { FakeManager } from './fake-manager.js'

test('Malformed and unroutable messages are ignored and the client keeps working', async (t) => {
  const { client, port2 } = setup(t)

  /** @type {string[]} */
  const warnings = []
  const originalWarn = console.warn
  console.warn = (/** @type {unknown[]} */ ...args) => {
    warnings.push(String(args[0]))
  }
  t.after(() => {
    console.warn = originalWarn
  })

  // Posting on port2 delivers to the server's port. None of these should throw
  // or wedge the server.
  port2.postMessage('garbage')
  port2.postMessage(42)
  port2.postMessage(null)
  port2.postMessage({ no: 'id or message' })
  // Well-formed envelope, but for an instance id the server never opened.
  // Posted twice to exercise the warn-once dedupe.
  port2.postMessage({ id: 'project-999:42', message: { value: 'whatever' } })
  port2.postMessage({ id: 'project-999:42', message: { value: 'whatever' } })

  // Let the messages flush through the event loop.
  await new Promise((resolve) => setImmediate(resolve))

  const projectId = await client.createProject({ name: 'mapeo' })
  assert.ok(projectId)
  const project = await client.getProject(projectId)
  const settings = await project.$getProjectSettings()
  assert.equal(settings.name, 'mapeo')

  // The unroutable id is warned about exactly once (deduped), not errored;
  // the structurally-invalid messages are dropped without any warning.
  const unrecognised = warnings.filter((w) => w.includes('project-999:42'))
  assert.equal(unrecognised.length, 1)
})

test('createMapeoServer().close() is idempotent', async (t) => {
  const { port1, port2 } = new MessageChannel()

  const server = createMapeoServer(
    /** @type {any} */ (new FakeManager()),
    port1,
  )
  const client = createMapeoClient(port2)

  port1.start()
  port2.start()

  t.after(async () => {
    await closeMapeoClient(client)
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
