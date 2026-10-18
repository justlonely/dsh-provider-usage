# Volcengine Ark Agent Plan / Coding Plan

[English] · [← Back to README](../README.md)

Volcengine Ark's **subscription plans** (Agent Plan / Coding Plan) do not expose their quota on the inference endpoint. It lives on Volcengine's **control plane** (OpenTOP OpenAPI) and has to be signed with an **IAM AK/SK pair** (V4 HMAC-SHA256). The plan key on the route (`ARK_AGENT_PLAN_API_KEY`, …) is a data-plane key that only authorizes model calls — quoting it for usage is refused upstream (observed: `GetAFPUsage requires Volcengine Ark SSO STS`), so those routes need the AK/SK pair *in addition to* the inference key.

## 1. The route

The `baseURL` picks the adapter: a path containing `/api/plan` is an Agent Plan, `/api/coding` a Coding Plan.

```yaml
llm-pi-ai:
  providers:
    ark-agent-plan:
      displayName: Volcengine Ark - Agent Plan
      apiKeyEnv: ARK_AGENT_PLAN_API_KEY
      api: openai-responses
      baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
    ark-coding-plan:
      displayName: Volcengine Ark - Coding Plan
      apiKeyEnv: ARK_CODING_PLAN_API_KEY
      baseURL: https://ark.cn-beijing.volces.com/api/coding   # Anthropic wire; use /api/coding/v3 for the OpenAI-compatible endpoint
```

The route id is arbitrary; the well-known ids `ark-agent-plan`, `ark-coding-plan`, `ark-agent-plan-cn` and `ark-coding-plan-cn` are recognized even when the profile omits `baseURL`.

## 2. Configure the AK/SK pair

Create or read an Access Key ID / Secret Access Key in the Volcengine console under Access Control (IAM) → Access keys (read access is enough for quota), then supply it either way:

```yaml
# ~/.dsh/.credentials.yaml (a process environment variable or a project .env of the same name works too)
refs:
  VOLC_ARK_ACCESS_KEY_ID: AKLT...
  VOLC_ARK_ACCESS_KEY_SECRET: ...
```

Each half takes the first ref that resolves: `VOLC_ARK_ACCESS_KEY_ID` → `VOLC_ACCESS_KEY_ID` → `VOLC_ACCESSKEY`, and `VOLC_ARK_ACCESS_KEY_SECRET` → `VOLC_ACCESS_KEY_SECRET` → `VOLC_SECRETKEY` → `VOLC_SECRET_KEY`.

Until the pair is configured the card reads "missing key (VOLC_ARK_ACCESS_KEY_ID + VOLC_ARK_ACCESS_KEY_SECRET)"; a wrong pair surfaces the control-plane error verbatim (e.g. `HTTP 401: InvalidAccessKey: The security token[...] is invalid.`).

## 3. What it shows

- **Agent Plan** — the 5h, weekly and monthly windows, with the used percentage derived from the absolute `Used`/`Quota` pair and a reset countdown (`AFPDaily` is omitted, matching the Ark console and `arkcli`).
- **Coding Plan** — the session (5h), weekly and monthly windows, using the backend's own used percentage. A plan that is unsubscribed or reclaimed reports no rows.
