/**
 * Kimi Code `/v1/usages` parsing.
 *
 * The endpoint has reported three shapes over its life, and an account with no
 * valid plan answers a fourth: an empty body (`{}`, HTTP 200, no error).
 *
 * - **ratio pools** (what the official CLI reads today):
 *   `usages: { limit_5h, limit_7d, limit_month_total, limit_month_code }`,
 *   each `{ used_ratio, reset_time }`. The pools are the plan itself: when the
 *   membership lapses the whole `usages` key disappears.
 * - **count windows**: `limits: [{ window, detail }]`, with string amounts and
 *   a camelCase `resetTime`; an optional `usage` summary rides beside them.
 * - **per-model data**: `data: [{ model_name, limit, used, ... }]`, where the
 *   `all` row is the overall weekly window.
 *
 * The distinction that matters to the panel is {@link KimiUsageResult.hasPlanData}:
 * a payload that carries quota data but yields no window is a parse failure the
 * user must see, while a payload with no quota container at all means "no
 * active plan" — rendering that as an empty card hides the very fact the user
 * opens the panel to check.
 * @module dsh-provider-usage/kimi
 */

import { orderUsageRows, toNumber, toResetAt, usageRow, type UsageRow } from './wire.ts'

/** Ratio-pool keys rendered by the panel, in display order. */
const RATIO_POOLS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['limit_5h', '5h limit'],
  ['limit_7d', 'weekly'],
  ['limit_month_total', 'monthly'],
]

/** Code-only monthly pool, shown when the combined monthly pool is absent. */
const CODE_MONTH_POOL = 'limit_month_code'

export interface KimiUsageResult {
  /** Windows to render; empty when the account has no active plan. */
  usages: UsageRow[]
  /**
   * Whether the response carried any quota container at all. `false` is the
   * "no active plan" verdict (the endpoint's `{}`), not an empty quota; a
   * `true` with zero rows means the payload carried data this parser could
   * not turn into a window.
   */
  hasPlanData: boolean
}

/** One ratio-pool entry (`used_ratio` is a fraction of the window). */
function ratioRow(raw: any, label: string): UsageRow | null {
  const ratio = toNumber(raw?.used_ratio)
  if (ratio === null) return null
  // Clamp: an overdrawn window can report a ratio above 1.
  const percent = Math.min(100, Math.max(0, ratio * 100))
  return {
    label,
    used: percent,
    limit: 100,
    remaining: 100 - percent,
    percent,
    resetAt: toResetAt(raw?.reset_time ?? raw?.resetTime),
  }
}

function parseRatioPools(pools: any): UsageRow[] {
  if (pools === null || typeof pools !== 'object' || Array.isArray(pools)) return []
  const rows: UsageRow[] = []
  for (const [key, label] of RATIO_POOLS) {
    const row = ratioRow(pools[key], label)
    if (row !== null) rows.push(row)
  }
  if (!rows.some((row) => row.label === 'monthly')) {
    const code = ratioRow(pools[CODE_MONTH_POOL], 'monthly')
    if (code !== null) rows.push(code)
  }
  return rows
}

/** Window label from a `limits[].window` descriptor (300 MINUTE → "5h limit"). */
function windowLabel(window: any): string {
  const duration = toNumber(window?.duration)
  if (duration === null) return 'limit'
  const unit = String(window?.timeUnit ?? window?.time_unit ?? '').toUpperCase()
  if (unit.includes('MINUTE')) return duration >= 60 && duration % 60 === 0 ? `${duration / 60}h limit` : `${duration}m limit`
  if (unit.includes('HOUR')) return `${duration}h limit`
  if (unit.includes('DAY')) return `${duration}d limit`
  if (unit.includes('MONTH')) return `${duration}mo limit`
  return 'limit'
}

function parseLimitWindows(limits: any): UsageRow[] {
  if (!Array.isArray(limits)) return []
  const rows: UsageRow[] = []
  for (const item of limits) {
    const detail = item?.detail !== null && typeof item?.detail === 'object' ? item.detail : item
    const row = usageRow(detail, windowLabel(item?.window))
    if (row !== null) rows.push(row)
  }
  return rows
}

function parseModelWindows(data: any): UsageRow[] {
  if (!Array.isArray(data)) return []
  const rows: UsageRow[] = []
  for (const item of data) {
    const isOverall = item?.model_name === 'all'
    const row = usageRow(item, isOverall ? 'weekly' : 'limit')
    if (row !== null) rows.push(isOverall ? { ...row, label: 'weekly' } : row)
  }
  return rows
}

/** True when the payload carries any quota container (see {@link KimiUsageResult}). */
function carriesQuota(payload: any): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const pools = payload.usages
  if (pools !== null && typeof pools === 'object' && !Array.isArray(pools) && Object.keys(pools).length > 0) return true
  if (Array.isArray(payload.data) && payload.data.length > 0) return true
  if (Array.isArray(payload.limits) && payload.limits.length > 0) return true
  const usage = payload.usage
  return usage !== null && typeof usage === 'object' && !Array.isArray(usage) && Object.keys(usage).length > 0
}

/**
 * Parse a Kimi Code usage response body into panel rows plus the plan verdict.
 * @param payload - the parsed JSON body (may be `{}` for a lapsed plan).
 */
export function parseKimiUsages(payload: any): KimiUsageResult {
  const pools = parseRatioPools(payload?.usages)
  if (pools.length > 0) return { usages: orderUsageRows(pools), hasPlanData: true }

  const models = parseModelWindows(payload?.data)
  if (models.length > 0) return { usages: orderUsageRows(models), hasPlanData: true }

  const rows: UsageRow[] = []
  const summary = usageRow(payload?.usage, 'weekly')
  if (summary !== null) rows.push({ ...summary, label: 'weekly' })
  rows.push(...parseLimitWindows(payload?.limits))
  return { usages: orderUsageRows(rows), hasPlanData: carriesQuota(payload) }
}
