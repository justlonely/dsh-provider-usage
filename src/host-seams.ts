/**
 * Host seams this plugin reads through `ctx.get` — the surfaces no compiler can
 * check.
 *
 * Everything imported by name (`credentialKey`, `launchEnvironmentOf`,
 * `Remote`, `TypertRemoteService`) is checked by the ESM linker: a renamed
 * export fails the import loudly. The *service* surfaces are different. They
 * arrive as opaque objects the plugin probes structurally
 * (`typeof service.method === 'function'`), so a host that renames
 * `credentials.resolve`, or stops exposing `llm.listProviders`, produces no
 * error anywhere — only cards that quietly read "no API key configured".
 *
 * The harness's own compatibility gate cannot cover this either. It compares
 * declared peer ranges against the runtime version, and this plugin declares an
 * open range (`>=0.1.2-alpha.3`) so a dsh upgrade can never silently drop the
 * panel; that choice moves the burden here, where drift is named instead of
 * guessed. Naming it is all this module does — the sections read through these
 * services stay individually defensive (see {@link readLiveSection}), because a
 * composition is allowed to omit what it does not use.
 * @module host-seams
 */

/** The `ctx.get` services this plugin reads, as resolved at query time. */
export interface HostServices {
  /** Credential records: OAuth grants and API-key references, or `undefined`. */
  credentials?: unknown
  /** The llm registry whose routes are enumerated, or `undefined`. */
  llm?: unknown
}

/** Whether a live service is an object this probe can look into at all. */
function isService(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

/** Whether a service object carries a callable method of that name. */
function hasMethod(holder: unknown, name: string): boolean {
  return isService(holder) && typeof (holder as Record<string, unknown>)[name] === 'function'
}

/**
 * Name every seam the plugin needs but the live services do not provide.
 *
 * Only the surfaces that decide whether a query can work at all are judged:
 * credential resolution (`resolve` for key references, `readRecord` for the
 * stored grants, `modifyRecord` for the Codex rotation) and route enumeration
 * (`llm.listProviders`, without which there is nothing to enumerate). The
 * settings and model-selection seams are deliberately absent from this list —
 * the plugin reads them defensively across three dsh generations, so their
 * absence degrades a detail rather than the query.
 * @param services - the services as `ctx.get` answered them; either may be
 *   `undefined` when the composition does not mount it.
 * @returns the missing seam names, or an empty array when nothing is missing.
 */
export function missingHostSeams(services: HostServices): string[] {
  const missing: string[] = []

  if (!isService(services.credentials)) missing.push('credentials')
  else {
    for (const name of ['readRecord', 'modifyRecord', 'resolve']) {
      if (!hasMethod(services.credentials, name)) missing.push(`credentials.${name}`)
    }
  }

  if (!isService(services.llm)) missing.push('llm')
  else if (!hasMethod(services.llm, 'listProviders')) missing.push('llm.listProviders')

  return missing
}
