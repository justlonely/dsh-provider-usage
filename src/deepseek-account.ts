/**
 * DeepSeek Account (dsh ≥ 0.1.7) — grant parsing and wallet summarizing.
 *
 * The harness composes the `deepseek-account` route from the account platform
 * plugin (`@deepseek-ai/dsh-deepseek-account-platform`): a browser PKCE
 * sign-in stores a long-lived grant in the credential records under
 * `deepseek-account-platform/default`, shaped `{ version: 1, token, issuer }`
 * where `issuer` is the configured `platformOrigin`. The platform answers a
 * balance query at `GET {issuer}/api/v0/users/get_user_summary` with the
 * grant in the `x-dsh-auth-token` header:
 *
 *     { "code": 0, "data": { "biz_code": 0, "biz_data": {
 *         "normal_wallets": [{ "currency": "CNY", "balance": "110.00" }],
 *         "bonus_wallets":  [{ "currency": "CNY", "balance": "25.50" }] } } }
 *
 * `normal_wallets` are recharge money, `bonus_wallets` are granted money —
 * kept separate by the platform, merged into the panel's
 * total/granted/toppedUp row vocabulary here. Balance strings follow the
 * big.js grammar the platform's web client accepts, including decimal
 * exponents (`0E-16`, `5.0000000000000000`).
 *
 * The token is not refreshable: HTTP 401 or a top-level `code: 40003` means
 * the stored sign-in is dead and only a new browser sign-in fixes it.
 * @module dsh-provider-usage/deepseek-account
 */
import { toNumber, type BalanceRow } from './wire.ts'

/** The stored account grant as written by the account platform. */
export interface DeepSeekAccountGrant {
  version: 1
  token: string
  issuer: string
}

/**
 * The slice of the harness credentials record seam this module needs. It is
 * structural, like the Codex store shape, so the module stays independent of
 * the (separately versioned) credential typings.
 */
export interface DeepSeekAccountRecordStore {
  readRecord(key: string): Promise<{ kind: string; payload?: unknown } | undefined>
}

/**
 * Thrown when the platform rejects the stored grant (HTTP 401 or top-level
 * response `code: 40003`): the panel reports "sign in again" instead of
 * retrying a dead token.
 */
export class DeepSeekAccountAuthRequiredError extends Error {
  readonly code = 'DEEPSEEK_ACCOUNT_AUTH_REQUIRED'

  constructor() {
    super('DeepSeek Account sign-in expired')
    this.name = 'DeepSeekAccountAuthRequiredError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate the grant payload the account platform persists. */
export function parseDeepSeekAccountGrant(payload: unknown): DeepSeekAccountGrant | null {
  if (!isObject(payload) || payload.version !== 1) return null
  if (typeof payload.token !== 'string' || payload.token === '') return null
  if (typeof payload.issuer !== 'string' || payload.issuer === '') return null
  let origin: URL
  try {
    origin = new URL(payload.issuer)
  } catch {
    return null
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null
  return { version: 1, token: payload.token, issuer: origin.origin }
}

/**
 * The credential record key (as `credentialKey(provider, slot)` composes it)
 * holding the account grant.
 */
export const DEEPSEEK_ACCOUNT_CREDENTIAL_KEY = 'deepseek-account-platform/default'

/**
 * Whether a detected route is the harness's built-in DeepSeek account route
 * with no sign-in behind it — the one route the harness composes
 * unconditionally, so it is listed whether or not this deployment ever signed
 * in. The panel leaves that card out: with no grant it could only ever read
 * "OAuth authorization missing", a fact the harness's own account page already
 * reports, and one that costs a card in the panel of everyone who uses the API
 * key route instead. The row returns on the poll after a sign-in.
 *
 * A *configured* route is never hidden this way. An unsigned pi-ai
 * `openai-codex` — registered only because the user configured it — keeps its
 * card precisely because "sign in again" is the hint a human needs there.
 * @param kind - the detected route's kind (`undefined` for an `unsupported`
 *   route, which carries no kind at all).
 * @param readGrant - reads the stored account grant; never called for other
 *   routes, so a poll reads the credential store only when it has to.
 * @returns true when the route should be left out of the panel.
 */
export async function isUnusedAccountRoute(
  kind: string | undefined,
  readGrant: () => Promise<DeepSeekAccountGrant | undefined>,
): Promise<boolean> {
  if (kind !== 'deepseek-account') return false
  return (await readGrant()) === undefined
}

/** Platform money amount as the panel displays it: two decimal places. */
function money(value: number): string {
  return value.toFixed(2)
}

/**
 * Merge the platform's wallet lists into one balance row per currency: the
 * total is recharge + granted, and the parts keep the panel's split
 * (`granted` = bonus wallets, `toppedUp` = normal wallets). Wallet entries
 * with a missing currency or a non-numeric balance are skipped — a partially
 * unreadable summary still shows the wallets that did parse.
 * @param wallets - the envelope's `biz_data` object (may be malformed).
 * @returns one row per currency seen, or an empty array.
 */
export function accountBalanceRows(wallets: unknown): BalanceRow[] {
  if (!isObject(wallets)) return []
  const merged = new Map<string, { total: number; granted: number; toppedUp: number }>()
  const add = (list: unknown, slot: 'granted' | 'toppedUp') => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (!isObject(entry)) continue
      const currency = typeof entry.currency === 'string' ? entry.currency.trim().toUpperCase() : ''
      const amount = toNumber(entry.balance)
      if (currency === '' || amount === null) continue
      const row = merged.get(currency) ?? { total: 0, granted: 0, toppedUp: 0 }
      row[slot] += amount
      row.total += amount
      merged.set(currency, row)
    }
  }
  add(wallets.normal_wallets, 'toppedUp')
  add(wallets.bonus_wallets, 'granted')
  return [...merged.entries()].map(([currency, row]) => ({
    currency,
    total: money(row.total),
    granted: money(row.granted),
    toppedUp: money(row.toppedUp),
  }))
}

/**
 * Parse one `get_user_summary` response envelope into balance rows.
 * @param payload - the parsed JSON body (any shape).
 * @returns the wallet rows, or an empty array when the envelope holds none.
 * @throws DeepSeekAccountAuthRequiredError when the platform answers the
 *   top-level `code: 40003` (invalid authorization) verdict.
 */
export function parseAccountSummaryEnvelope(payload: unknown): BalanceRow[] {
  if (!isObject(payload)) return []
  if (payload.code === 40003) throw new DeepSeekAccountAuthRequiredError()
  const data = isObject(payload.data) ? payload.data : null
  if (payload.code !== 0 || data === null || data.biz_code !== 0) return []
  return accountBalanceRows(data.biz_data)
}
