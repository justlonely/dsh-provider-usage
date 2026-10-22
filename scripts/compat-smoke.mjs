/**
 * Compatibility watch: judge the *packed* plugin against one published dsh
 * release, the way a user's harness will.
 *
 * This plugin declares an open host range (`>=0.1.2-alpha.3`) so a dsh upgrade
 * can never silently drop the panel through the harness's peer gate. That trade
 * removes the harness's early warning, so this script puts it back — it fails
 * the build the moment a released dsh stops accepting the artifact or stops
 * answering a live query, instead of a user finding out.
 *
 * Two checks, both against the real thing:
 *
 * 1. Gate replay — `evaluatePluginCompatibility` from that release's own
 *    `@deepseek-ai/dsh-app-boot`, fed the packed manifest. This is the exact
 *    function that skips a bundle at startup, so a green run means "this dsh
 *    would load this tarball".
 * 2. Live query — a real Cordis `Context` with stand-in `llm`, `settings` and
 *    `credentials` services, running the plugin's own `apply` and `list`
 *    against *that release's* host packages. Note that `pnpm typecheck` cannot
 *    catch this class of drift at all: `src/shims.d.ts` declares the host
 *    modules ambiently, so TypeScript never sees their real signatures.
 *
 * Network is stubbed: this watches the host seam, not DeepSeek's uptime.
 *
 * Usage: node scripts/compat-smoke.mjs <scratch-dir> [expected-dsh-version]
 * The scratch directory must hold `node_modules/dsh-provider-usage` (the
 * unpacked tarball) beside `node_modules/@deepseek-ai/*` for the target
 * release — see .github/workflows/compat.yml.
 * @module scripts/compat-smoke
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const scratch = process.argv[2]
const expectedRuntime = process.argv[3]
if (scratch === undefined) {
  process.stderr.write('usage: node scripts/compat-smoke.mjs <scratch-dir> [expected-dsh-version]\n')
  process.exit(2)
}

const failures = []
/** Report one check; a failure is collected so the run still reports the rest. */
function check(ok, label, detail = '') {
  process.stdout.write(`${ok ? 'ok   ' : 'FAIL '}${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures.push(label)
}

const pluginDir = join(scratch, 'node_modules', 'dsh-provider-usage')
if (!existsSync(join(pluginDir, 'package.json'))) {
  process.stderr.write(`no packed plugin under ${pluginDir}; install the tarball there first\n`)
  process.exit(2)
}

// Bare specifiers have to resolve against the scratch tree, not this repo, or
// the plugin would bind to the repo's pinned devDependencies and the whole
// point — testing the host the user actually runs — would be lost.
const entry = join(scratch, 'compat-probe-entry.mjs')
writeFileSync(
  entry,
  [
    "export * as appBoot from '@deepseek-ai/dsh-app-boot'",
    "export { Context } from '@deepseek-ai/cordis'",
    "export * as plugin from 'dsh-provider-usage'",
    '',
  ].join('\n'),
)
const { appBoot, Context, plugin } = await import(pathToFileURL(entry).href)

const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const runtime = appBoot.getDshRuntimeVersion()
process.stdout.write(`plugin ${manifest.name}@${manifest.version} against dsh ${runtime}\n\n`)

if (expectedRuntime !== undefined) {
  check(runtime === expectedRuntime, 'app-boot reports the requested dsh version', `got ${runtime}`)
}

// 1. The harness's own gate, replayed on the artifact a user would install.
const issue = appBoot.evaluatePluginCompatibility(manifest, {}, runtime)
check(
  issue === undefined,
  'the peer gate accepts the packed manifest',
  issue === undefined ? '' : `rejected peers ${JSON.stringify(issue.peers)}`,
)

// 2. A live query against this release's host packages.
const ROUTES = [
  { id: 'deepseek-official', name: 'DeepSeek' },
  { id: 'deepseek-account', name: 'DeepSeek Account' },
  { id: 'kimi-coding', name: 'Kimi Code' },
]
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
const GRANT = {
  kind: 'grant',
  payload: { version: 1, token: 'stored-token', issuer: 'https://platform.deepseek.com' },
}
const ACCOUNT_KEY = 'deepseek-account-platform/default'

// The account adapter is expected to reach its balance endpoint; answering
// "invalid authorization" keeps the run offline and deterministic while still
// exercising the whole adapter, parser and view path.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ code: 40003 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** Mount the plugin on a stand-in host and return the rows it produced. */
async function rows(readRecord) {
  const ctx = new Context()
  const warnings = []
  ctx.provide('llm', { listProviders: () => ROUTES, listConfigurableProviders: () => [] })
  ctx.provide('settings', { get: async () => undefined })
  ctx.provide('credentials', {
    readRecord,
    modifyRecord: async () => undefined,
    resolve: async () => undefined,
  })
  ctx.provide('logger', { warn: (message) => warnings.push(message) })
  plugin.apply(ctx, CONFIG)
  const result = await ctx.usage.list()
  return { ids: result.providers.map((entry) => entry.id), warnings }
}

const unsigned = await rows(async () => undefined)
check(unsigned.ids.length > 0, 'an unsigned host still yields provider rows', `got ${JSON.stringify(unsigned.ids)}`)
check(
  !unsigned.ids.includes('deepseek-account'),
  'the composed account route stays hidden while unsigned',
  `got ${JSON.stringify(unsigned.ids)}`,
)
check(
  unsigned.warnings.length === 0,
  'every host seam the plugin reads is present',
  unsigned.warnings.join(' | '),
)

const signed = await rows(async (key) => (key === ACCOUNT_KEY ? GRANT : undefined))
check(
  signed.ids.includes('deepseek-account'),
  'the account route returns once a grant is stored',
  `got ${JSON.stringify(signed.ids)}`,
)

// 3. Packaging: the browser half has to ship, or the panel has nothing to mount.
const client = join(pluginDir, 'lib', 'client.js')
check(
  existsSync(client) && statSync(client).size > 0,
  'the client bundle ships with the package',
  existsSync(client) ? `${statSync(client).size} bytes` : 'missing',
)

process.stdout.write(
  failures.length === 0
    ? `\ncompatible with dsh ${runtime}\n`
    : `\n${failures.length} check(s) failed against dsh ${runtime}: ${failures.join('; ')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
