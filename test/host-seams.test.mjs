/**
 * Regression tests for the host-seam probe (`src/host-seams.ts`).
 *
 * The gate in `@deepseek-ai/dsh-app-boot` only judges *declared* peer ranges,
 * and this plugin declares an open range so a dsh upgrade can never silently
 * drop the panel. That moves the burden onto this probe: when a host renames
 * `credentials.resolve` or drops `llm.listProviders`, the cards degrade to
 * "no API key configured" and nothing else says why. These tests pin which
 * surfaces count as missing, and — just as important — which do not, because a
 * false positive here would train its readers to ignore the line.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { missingHostSeams } from '../src/host-seams.ts'

const credentials = { readRecord: () => {}, modifyRecord: () => {}, resolve: () => {} }
const llm = { listProviders: () => [] }

test('a complete host reports no missing seam', () => {
  assert.deepEqual(missingHostSeams({ credentials, llm }), [])
})

test('an extra member on a healthy host is not drift', () => {
  // Hosts grow surfaces; only the ones this plugin calls are judged.
  assert.deepEqual(missingHostSeams({ credentials, llm: { listProviders: () => [], listConfigurableProviders: () => [] } }), [])
})

test('an absent service is named by itself', () => {
  assert.deepEqual(missingHostSeams({}), ['credentials', 'llm'])
  assert.deepEqual(missingHostSeams({ credentials }), ['llm'])
  assert.deepEqual(missingHostSeams({ llm }), ['credentials'])
})

test('a renamed method is named precisely, not as a whole service', () => {
  // The drift signature this probe exists for: the service is still there, so
  // nothing throws, but the method the plugin calls is gone.
  assert.deepEqual(missingHostSeams({ credentials: { readRecord: () => {}, modifyRecord: () => {} }, llm }), [
    'credentials.resolve',
  ])
  assert.deepEqual(missingHostSeams({ credentials, llm: {} }), ['llm.listProviders'])
})

test('a non-callable member counts as missing', () => {
  assert.deepEqual(missingHostSeams({ credentials: { ...credentials, resolve: 'yes' }, llm }), ['credentials.resolve'])
})

test('a null or primitive service is absent, not a crash', () => {
  // `ctx.get` answers with whatever the composition registered; a probe that
  // threw here would take the whole query down instead of reporting drift.
  assert.deepEqual(missingHostSeams({ credentials: null, llm: 7 }), ['credentials', 'llm'])
  assert.deepEqual(missingHostSeams({ credentials: 'credentials', llm: [] }), ['credentials', 'llm.listProviders'])
})
