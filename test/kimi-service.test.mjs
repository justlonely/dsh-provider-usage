/**
 * End-to-end adapter tests for the Kimi Code route (`src/index.ts`): the
 * service, the wire adapter and the parser together.
 *
 * The bug these pin is the *state* the panel receives. Kimi answers a lapsed
 * membership with HTTP 200 and `{}`; parsed as zero rows the card rendered as
 * a bare provider name. `apply()` must turn that body into the
 * `no-subscription` status, while a real plan response still flows through as
 * usage windows. Network is stubbed — this watches our side of the contract.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const CONFIG = {
  refreshSeconds: 60,
  balanceRedThreshold: 10,
  balanceYellowThreshold: 30,
  autoDetect: true,
  queryTimeoutMs: 5000,
  queryRetries: 0,
  queryRetryDelayMs: 1000,
  providers: [],
}

/** Mount the plugin on a minimal host with one Kimi route and a stored key. */
async function listKimi(body) {
  const fetchCalls = []
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'kimi-coding', name: 'kimi-coding' }],
    listConfigurableProviders: () => [],
  })
  ctx.provide('settings', { get: async () => undefined })
  ctx.provide('credentials', {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    resolve: async () => ({ value: 'sk-kimi-test' }),
  })
  ctx.provide('logger', { warn: () => {} })
  apply(ctx, CONFIG)
  const result = await ctx.usage.list()
  return { providers: result.providers, fetchCalls }
}

test('an expired membership reaches the panel as `no-subscription`, not an empty card', async () => {
  const { providers, fetchCalls } = await listKimi({})
  assert.equal(fetchCalls.length, 1)
  assert.match(fetchCalls[0], /^https:\/\/api\.kimi\.com\/coding\/v1\/usages$/)

  const [kimi] = providers
  assert.equal(kimi.id, 'kimi-coding')
  assert.equal(kimi.status, 'no-subscription')
  assert.equal(kimi.message, null)
  assert.equal(kimi.kind, 'usage')
  assert.equal(kimi.usages, null)
  assert.equal(kimi.balances, null)
})

test('an active ratio-pool plan still reaches the panel as usage windows', async () => {
  const { providers } = await listKimi({
    usages: {
      limit_5h: { used_ratio: 0.2, reset_time: '2026-10-21T20:00:00Z' },
      limit_7d: { used_ratio: 0.1, reset_time: '2026-10-26T00:00:00Z' },
      limit_month_total: { used_ratio: 0.05, reset_time: '2026-11-01T00:00:00Z' },
    },
  })

  const [kimi] = providers
  assert.equal(kimi.status, 'ok')
  assert.deepEqual(kimi.usages.map((row) => row.label), ['5h limit', 'weekly', 'monthly'])
  assert.deepEqual(kimi.usages.map((row) => Math.round(row.percent)), [20, 10, 5])
})

test('a payload with quota data but no window is a visible query error', async () => {
  const { providers } = await listKimi({ usages: { limit_5h: {} } })
  const [kimi] = providers
  assert.equal(kimi.status, 'error')
  assert.match(String(kimi.message), /no usage windows/)
})
