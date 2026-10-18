# 火山方舟 Agent Plan / Coding Plan

[简体中文] · [← 返回 README](../README_ZH.md)

火山方舟的**订阅套餐**（Agent Plan / Coding Plan）额度不在推理端点上，而在火山**控制面**（OpenTOP OpenAPI），且必须用 **IAM AK/SK 做 V4 签名**。路由上那把套餐 key（`ARK_AGENT_PLAN_API_KEY` 等）是数据面 key，只能调模型：拿它查额度会被拒（实测 `GetAFPUsage requires Volcengine Ark SSO STS`），面板会一直查不到数。因此这两条路由除了推理 key，还要额外配一对 AK/SK。

## 1. 路由

`baseURL` 决定用哪个适配器：含 `/api/plan` → Agent Plan，含 `/api/coding` → Coding Plan。

```yaml
llm-pi-ai:
  providers:
    ark-agent-plan:
      displayName: 火山方舟 - Agent Plan
      apiKeyEnv: ARK_AGENT_PLAN_API_KEY
      api: openai-responses
      baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
    ark-coding-plan:
      displayName: 火山方舟 - Coding Plan
      apiKeyEnv: ARK_CODING_PLAN_API_KEY
      baseURL: https://ark.cn-beijing.volces.com/api/coding   # Anthropic 协议；OpenAI 兼容端点用 /api/coding/v3
```

路由 id 任意；`ark-agent-plan` / `ark-coding-plan` / `ark-agent-plan-cn` / `ark-coding-plan-cn` 这些常见 id 即使省略 `baseURL` 也能被识别。

## 2. 配置 AK/SK

在火山引擎控制台 → 访问控制（IAM）→ 访问密钥，创建或查看 Access Key ID / Secret Access Key（查额度只需读权限），然后任选一种方式提供：

```yaml
# ~/.dsh/.credentials.yaml（也可用同名进程环境变量或项目 .env）
refs:
  VOLC_ARK_ACCESS_KEY_ID: AKLT...
  VOLC_ARK_ACCESS_KEY_SECRET: ...
```

取值顺序：`VOLC_ARK_ACCESS_KEY_ID` → `VOLC_ACCESS_KEY_ID` → `VOLC_ACCESSKEY`（secret 同理，另有 `VOLC_ACCESS_KEY_SECRET` / `VOLC_SECRETKEY` / `VOLC_SECRET_KEY` 别名），第一个有值的生效。

没配时面板显示「未配置密钥（VOLC_ARK_ACCESS_KEY_ID + VOLC_ARK_ACCESS_KEY_SECRET)」；配错时直接显示控制面错误（如 `HTTP 401: InvalidAccessKey: The security token[...] is invalid.`）。

## 3. 展示内容

- **Agent Plan** —— 5h / 每周 / 每月三个窗口，按 `Used`/`Quota` 绝对值算已用百分比 + 重置倒计时（`AFPDaily` 与控制台、`arkcli` 一致，不展示）。
- **Coding Plan** —— session（5h）/ 每周 / 每月三个窗口，直接用后端的已用百分比。套餐未订阅或已回收时该路由没有数据行。
