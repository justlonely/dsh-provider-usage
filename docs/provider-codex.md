# OpenAI Codex via OAuth

[English] · [← Back to README](../README.md)

OpenAI Codex is a **ChatGPT-subscription** provider: it authenticates with an OAuth access token, not an API key, so there is nothing to paste into a key field. dsh itself has no OAuth *button* for this route — but this plugin can still query its usage, because it reads the OAuth grant out of the harness credential store. Set the provider up once, and the usage panel shows your real 5-hour / weekly Codex windows.

## 1. Make sure the route exists

The sign-in writes a grant record addressed `llm-pi-ai/openai-codex`, and the route has to be configured for `ctx.llm` to list it. With the stock `llm-pi-ai` adapter mounted (default in the web profile), an empty profile is enough — e.g. in `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
```

## 2. Sign in through the harness authorization seam

`dsh-llm-pi-ai` registers an "OpenAI (ChatGPT Plus/Pro)" OAuth flow for `openai-codex` on the harness authorization seam (`ctx.authorization`, credential key `llm-pi-ai/openai-codex`). Complete it from any surface that runs that flow — a sign-in entry on the harness model/authorization UI, or any pi-ai client whose login persists through the harness credential store. Finish the browser (or device-code) flow with your ChatGPT account. The harness then stores the grant under `~/.dsh/.credentials.yaml` as `llm-pi-ai/openai-codex`:

```yaml
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: <access token>
      refresh: <refresh token>
      expires: <epoch ms>
      accountId: <chatgpt account id>
```

> The grant must land in the harness credential store (the record above). Codex clients that keep their own credential file (e.g. `dsh-codex`'s `$DSH_HOME/.openai-codex-auth.json`, or the Codex CLI's `~/.codex/auth.json`) do not write this record, so this plugin cannot see them.

## 3. Watch the usage

That's it. The route is auto-detected (`ctx.llm` lists `openai-codex`), and the plugin:

1. reads the grant record from the credential store on every poll (no caching),
2. refreshes the OAuth token automatically when it is within 30 s of expiry, deciding **and** rotating inside the store's exclusive lock — so a concurrent process that already rotated the grant is adopted instead of spending the same single-use refresh token twice, and a write that fails is reported rather than swallowed,
3. calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>` and the `ChatGPT-Account-Id` header derived from the token's own JWT claim, retrying once after a refresh if the endpoint answers `401`.

The panel then shows your subscription's **5h limit**, **weekly** windows (used %, reset countdown) plus **credits** and **spend control** balances when the plan reports them. If the grant is missing the card reads "OAuth authorization missing (llm-pi-ai/openai-codex)" — sign in again with step 2. If upstream instead *rejects* the stored refresh token (`refresh_token_reused` / `invalid_grant`, i.e. the token was already spent or revoked and the rotation never landed here), the card reads "OAuth authorization expired — sign in to Codex again" with the raw upstream detail on hover, and the plugin stops calling the token endpoint for ten minutes instead of once per poll.

## 4. Troubleshooting: intermittent "Our servers are currently overloaded"

The Codex backend occasionally answers with `Codex error: Our servers are currently overloaded. Please try again later.`, and the harness fails the round with `PI_AI_ERROR`. This is **transient overload on OpenAI's side** (account, quota, and network are usually fine — `GET /wham/usage` confirms window headroom), yet the default configuration never retries, for two reasons:

1. pi-ai's Codex client recognizes `overloaded` as retryable, but its default retry count is 0 (`dsh-llm-pi-ai` explicitly passes `maxRetries: 0`);
2. once the error bubbles up, its text contains no `5xx` / `rate limit` / `timeout` keyword, so it is classified as the catch-all `PI_AI_ERROR` — which is **not** among `dsh-llm-retry`'s default retryable codes (`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`), so the round fails immediately.

Add a `retryPolicy` for this provider in `~/.dsh/settings.yaml` that includes `PI_AI_ERROR` in the retryable codes (takes effect on a new session):

```yaml
llm-pi-ai:
  providers:
    openai-codex:
      retryPolicy:
        mode: normal
        maxRetries: 10
        retryableCodes:
          - EMPTY_RESPONSE
          - RATE_LIMIT
          - SERVER
          - TIMEOUT
          - TRANSPORT
          - PI_AI_ERROR
        backoff:
          initialDelayMs: 2000   # first retry delay, doubled each attempt
          maxDelayMs: 60000      # per-attempt delay cap
          jitterRatio: 0.2       # ±20% jitter
```

Do not confuse this with the other, **deterministic** failure: some models are unavailable to ChatGPT-subscription accounts, and the backend answers `400 The '<model>' model is not supported when using Codex with a ChatGPT account.` (observed with e.g. `gpt-5.3-codex-spark`, `gpt-5-codex`). That is a permanent error — retrying won't help; switch to a model your account supports (e.g. the `gpt-5.4` / `gpt-5.5` / `gpt-5.6` families).
