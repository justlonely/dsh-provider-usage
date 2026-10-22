/**
 * Regression tests for the Kimi Code usage parser (`src/kimi.ts`).
 *
 * The endpoint's two facts that are invisible from the panel:
 *
 * - **A lapsed membership is HTTP 200 with `{}`.** No error, no quota
 *   container. Parsed naively that is "zero rows", which used to render as a
 *   card with nothing under the provider name — the exact state a reader
 *   opens the panel to diagnose. `hasPlanData: false` is what turns it into
 *   an explicit "no active plan" verdict.
 * - **The payload generation moved from `limits` to ratio pools.** The
 *   current body carries `usages: { limit_5h, limit_7d, limit_month_total }`
 *   with `used_ratio` fractions; the older one carries `limits[]` count
 *   windows plus an optional `usage` summary. Both stay supported, and the
 *   pools win when present so the 5h window is not listed twice.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseKimiUsages } from '../src/kimi.ts'

test('an expired membership (`{}`) is reported as no plan data', () => {
  assert.deepEqual(parseKimiUsages({}), { usages: [], hasPlanData: false })
})

test('metadata without a quota container is no plan data either', () => {
  const result = parseKimiUsages({
    user: { user_id: 'u-1', user_level_name: 'Free' },
    version: '2026-09',
  })
  assert.equal(result.hasPlanData, false)
  assert.deepEqual(result.usages, [])
})

test('ratio pools produce 5h + monthly rows and suppress the duplicate limits window', () => {
  const result = parseKimiUsages({
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '25', remaining: '75', resetTime: '2026-09-16T20:15:44.757047Z' },
      },
    ],
    usages: {
      limit_5h: { used_ratio: 0, reset_time: '2026-09-16T20:15:44Z' },
      limit_month_total: { used_ratio: 0.0056, reset_time: '2026-10-17T00:00:00Z' },
      limit_month_code: { used_ratio: 0.0028, reset_time: '2026-10-17T00:00:00Z' },
    },
  })

  assert.equal(result.hasPlanData, true)
  assert.deepEqual(result.usages.map((row) => row.label), ['5h limit', 'monthly'])
  const [fiveHour, monthly] = result.usages
  assert.equal(fiveHour.percent, 0)
  assert.equal(fiveHour.resetAt, '2026-09-16T20:15:44.000Z')
  assert.ok(Math.abs(monthly.percent - 0.56) < 1e-9, `monthly percent was ${monthly.percent}`)
  assert.equal(monthly.resetAt, '2026-10-17T00:00:00.000Z')
})

test('weekly ratio pool renders between the 5h and monthly windows', () => {
  const result = parseKimiUsages({
    usages: {
      limit_month_total: { used_ratio: 0.5, reset_time: '2026-10-17T00:00:00Z' },
      limit_7d: { used_ratio: 0.25, reset_time: '2026-09-20T00:00:00Z' },
      limit_5h: { used_ratio: 0.75, reset_time: '2026-09-16T20:15:44Z' },
    },
  })
  assert.deepEqual(result.usages.map((row) => row.label), ['5h limit', 'weekly', 'monthly'])
  assert.deepEqual(result.usages.map((row) => row.percent), [75, 25, 50])
})

test('a code-only monthly pool stands in for the combined one', () => {
  const result = parseKimiUsages({
    usages: { limit_month_code: { used_ratio: 0.1, reset_time: '2026-10-17T00:00:00Z' } },
  })
  assert.deepEqual(result.usages.map((row) => row.label), ['monthly'])
  assert.equal(result.usages[0].percent, 10)
})

test('the legacy summary + limits payload still renders in window order', () => {
  const result = parseKimiUsages({
    usage: { limit: '100', used: '25', remaining: '75', resetTime: '2026-09-23T00:00:00Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '40', remaining: '60', resetTime: '2026-09-16T20:15:44Z' },
      },
    ],
  })
  assert.equal(result.hasPlanData, true)
  assert.deepEqual(result.usages.map((row) => row.label), ['5h limit', 'weekly'])
  assert.deepEqual(result.usages.map((row) => row.percent), [40, 25])
})

test('per-model `data` rows keep the overall window as the weekly row', () => {
  const result = parseKimiUsages({
    data: [
      { model_name: 'all', limit: 100, used: 10 },
      { model_name: 'kimi-k2.7-code', limit: 50, used: 5 },
    ],
  })
  assert.deepEqual(result.usages.map((row) => row.label), ['weekly', 'kimi-k2.7-code'])
  assert.deepEqual(result.usages.map((row) => row.percent), [10, 10])
})

test('quota data that yields no window stays a parse failure', () => {
  const result = parseKimiUsages({ usages: { limit_5h: {} } })
  assert.equal(result.hasPlanData, true)
  assert.deepEqual(result.usages, [])
})

test('ratios above 1 are clamped, not rendered past the bar', () => {
  const result = parseKimiUsages({ usages: { limit_5h: { used_ratio: 1.4 } } })
  assert.equal(result.usages[0].percent, 100)
  assert.equal(result.usages[0].remaining, 0)
})
