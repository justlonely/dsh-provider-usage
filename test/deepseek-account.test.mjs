/**
 * Regression tests for the DeepSeek Account helpers (`src/deepseek-account.ts`).
 *
 * dsh ≥ 0.1.7 composes the `deepseek-account` route from the account
 * platform's stored grant, and the platform's wallet summary carries quirks
 * worth pinning: the big.js-style decimal grammar (`0E-16`,
 * `5.0000000000000000`), separate normal/bonus wallet lists that must merge
 * into the panel's total/granted/toppedUp row per currency, and the
 * `code: 40003` top-level verdict that means "sign in again".
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEEPSEEK_ACCOUNT_CREDENTIAL_KEY,
  DeepSeekAccountAuthRequiredError,
  accountBalanceRows,
  isUnusedAccountRoute,
  parseAccountSummaryEnvelope,
  parseDeepSeekAccountGrant,
} from '../src/deepseek-account.ts'

test('credential key matches the account platform record key', () => {
  // dsh-deepseek-account-platform stores its grant under
  // credentialKey('deepseek-account-platform', 'default').
  assert.equal(DEEPSEEK_ACCOUNT_CREDENTIAL_KEY, 'deepseek-account-platform/default')
})

test('parseDeepSeekAccountGrant accepts the stored grant shape', () => {
  const grant = parseDeepSeekAccountGrant({ version: 1, token: 'tok-1', issuer: 'https://platform.deepseek.com/' })
  assert.deepEqual(grant, { version: 1, token: 'tok-1', issuer: 'https://platform.deepseek.com' })
})

test('parseDeepSeekAccountGrant normalizes the issuer origin', () => {
  const grant = parseDeepSeekAccountGrant({ version: 1, token: 'tok-1', issuer: 'https://platform.deepseek.com/a/b?x=1' })
  assert.equal(grant?.issuer, 'https://platform.deepseek.com')
})

test('parseDeepSeekAccountGrant rejects malformed payloads', () => {
  assert.equal(parseDeepSeekAccountGrant(undefined), null)
  assert.equal(parseDeepSeekAccountGrant('grant'), null)
  assert.equal(parseDeepSeekAccountGrant({ version: 2, token: 'tok-1', issuer: 'https://platform.deepseek.com' }), null)
  assert.equal(parseDeepSeekAccountGrant({ version: 1, token: '', issuer: 'https://platform.deepseek.com' }), null)
  assert.equal(parseDeepSeekAccountGrant({ version: 1, token: 'tok-1', issuer: 'not a url' }), null)
  assert.equal(parseDeepSeekAccountGrant({ version: 1, token: 'tok-1', issuer: 'ftp://platform.deepseek.com' }), null)
})

test('accountBalanceRows merges normal and bonus wallets per currency', () => {
  const rows = accountBalanceRows({
    normal_wallets: [
      { currency: 'CNY', balance: '110.00' },
      { currency: 'USD', balance: '3' },
    ],
    bonus_wallets: [{ currency: 'CNY', balance: '25.5' }],
  })
  assert.deepEqual(rows, [
    { currency: 'CNY', total: '135.50', granted: '25.50', toppedUp: '110.00' },
    { currency: 'USD', total: '3.00', granted: '0.00', toppedUp: '3.00' },
  ])
})

test('accountBalanceRows accepts the platform big.js decimal grammar', () => {
  const rows = accountBalanceRows({
    normal_wallets: [{ currency: 'CNY', balance: '5.0000000000000000' }],
    bonus_wallets: [{ currency: 'CNY', balance: '0E-16' }],
  })
  assert.deepEqual(rows, [{ currency: 'CNY', total: '5.00', granted: '0.00', toppedUp: '5.00' }])
})

test('accountBalanceRows skips unreadable wallets and malformed input', () => {
  assert.deepEqual(accountBalanceRows(undefined), [])
  assert.deepEqual(accountBalanceRows('wallets'), [])
  assert.deepEqual(accountBalanceRows({ normal_wallets: 'nope', bonus_wallets: null }), [])
  assert.deepEqual(
    accountBalanceRows({
      normal_wallets: [{ currency: 'CNY', balance: '10' }, { currency: '', balance: '1' }, { currency: 'CNY', balance: 'abc' }, null],
      bonus_wallets: [],
    }),
    [{ currency: 'CNY', total: '10.00', granted: '0.00', toppedUp: '10.00' }],
  )
})

test('parseAccountSummaryEnvelope unwraps the platform envelope', () => {
  const rows = parseAccountSummaryEnvelope({
    code: 0,
    data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: 'CNY', balance: '42' }], bonus_wallets: [] } },
  })
  assert.deepEqual(rows, [{ currency: 'CNY', total: '42.00', granted: '0.00', toppedUp: '42.00' }])
})

test('parseAccountSummaryEnvelope maps code 40003 to the reauth verdict', () => {
  assert.throws(() => parseAccountSummaryEnvelope({ code: 40003 }), DeepSeekAccountAuthRequiredError)
})

test('parseAccountSummaryEnvelope returns empty for non-success envelopes', () => {
  assert.deepEqual(parseAccountSummaryEnvelope(undefined), [])
  assert.deepEqual(parseAccountSummaryEnvelope({ code: 1, data: { biz_code: 0, biz_data: {} } }), [])
  assert.deepEqual(parseAccountSummaryEnvelope({ code: 0, data: { biz_code: 7, biz_data: {} } }), [])
  assert.deepEqual(parseAccountSummaryEnvelope({ code: 0 }), [])
  assert.deepEqual(parseAccountSummaryEnvelope({ code: 0, data: { biz_code: 0, biz_data: null } }), [])
})

test('isUnusedAccountRoute hides the composed account route only while unsigned', async () => {
  const grant = { version: 1, token: 'token', issuer: 'https://platform.deepseek.com' }
  assert.equal(await isUnusedAccountRoute('deepseek-account', async () => undefined), true)
  assert.equal(await isUnusedAccountRoute('deepseek-account', async () => grant), false)
})

test('isUnusedAccountRoute never hides a configured route', async () => {
  // An unsigned pi-ai `openai-codex` exists only because the user configured
  // it, and "OAuth authorization missing" is exactly the sign-in hint to keep.
  // An `unsupported` detected route carries no kind at all.
  let reads = 0
  const readGrant = async () => {
    reads += 1
    return undefined
  }
  assert.equal(await isUnusedAccountRoute('openai-codex', readGrant), false)
  assert.equal(await isUnusedAccountRoute('kimi-coding', readGrant), false)
  assert.equal(await isUnusedAccountRoute(undefined, readGrant), false)
  assert.equal(reads, 0, 'the credential store is read only for the account route')
})
