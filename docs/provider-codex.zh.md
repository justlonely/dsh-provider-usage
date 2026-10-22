# 通过 OAuth 添加 OpenAI Codex

[简体中文] · [← 返回 README](../README_ZH.md)

OpenAI Codex 是 **ChatGPT 订阅制** Provider：它用 OAuth access token 认证，而不是 API key，所以没有任何密钥可填。dsh 本身没有为该路由内置 OAuth 登录按钮——但本插件依然能查询它的余量，因为插件会直接从 harness 凭据库读取登录后存入的授权记录。按下面步骤配置一次，用量面板就能展示真实的 Codex 5 小时 / 每周窗口。

## 1. 确认路由已配置

登录会把授权记录写入 `llm-pi-ai/openai-codex`，且路由需要已配置，`ctx.llm` 才会列出它。默认 web profile 已挂载 `llm-pi-ai` 适配器，空 profile 即可——例如在 `~/.dsh/settings.yaml` 中：

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
```

## 2. 通过 harness 授权 seam 登录

`dsh-llm-pi-ai` 在 harness 授权 seam（`ctx.authorization`，凭据键 `llm-pi-ai/openai-codex`）上为 `openai-codex` 注册了 "OpenAI (ChatGPT Plus/Pro)" 的 OAuth 流程。从任何调起该流程的入口完成登录——harness 模型/授权界面上的登录入口，或任何会把登录结果持久化到 harness 凭据库的 pi-ai 客户端。用你的 ChatGPT 账号完成浏览器（或设备码）流程后，harness 会把授权记录存到 `~/.dsh/.credentials.yaml` 的 `llm-pi-ai/openai-codex` 下：

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

> 授权记录必须落在 harness 凭据库（即上面的记录）。使用独立凭据文件的 Codex 客户端（如 `dsh-codex` 的 `$DSH_HOME/.openai-codex-auth.json`，或 Codex CLI 的 `~/.codex/auth.json`）不会写入该记录，本插件无法读取。

## 3. 查看余量

配置完成。路由会被自动探测（`ctx.llm` 会列出 `openai-codex`），插件会：

1. 每次轮询都从凭据库**实时读取**授权记录（不缓存）；
2. access token 距过期不足 30 秒时**自动刷新** OAuth 令牌，且**判断与轮换都发生在凭据库的排他锁内**——并发进程已经轮换过就复用它，不会把同一枚一次性 refresh token 花掉两次；回写失败会**报错**而不是被静默吞掉；
3. 用 `Authorization: Bearer <access>` + 从令牌 JWT 中解析出的 `ChatGPT-Account-Id` 头请求 `GET https://chatgpt.com/backend-api/wham/usage`；若返回 `401` 会自动刷新一次并重试。

面板随即展示订阅的 **5h 上限**、**每周**窗口（已用百分比 + 重置倒计时），以及计划上报的 **credits** 与 **spend control** 余额。若授权记录缺失，卡片会显示「未完成 OAuth 授权（llm-pi-ai/openai-codex）」，按第 2 步重新登录即可。若上游**拒绝**了记录里的 refresh token（`refresh_token_reused` / `invalid_grant`，即这枚 token 已被消费或撤销、而那次轮换没能落到本地），卡片会显示「OAuth 授权已失效，需重新登录 Codex」（悬停可看上游原始报错），并且插件在十分钟内不再反复请求令牌端点，而不是每轮轮询都撞一次。

## 4. 故障排除：间歇性 "Our servers are currently overloaded"

Codex 后端偶尔会返回 `Codex error: Our servers are currently overloaded. Please try again later.`，harness 随即以 `PI_AI_ERROR` 判本轮失败。这是 **OpenAI 端的间歇性过载**（账号、配额、网络通常都正常——可用 `GET /wham/usage` 确认窗口余量），但默认配置下不会自动重试，原因有两层：

1. pi-ai 的 Codex 客户端内部认得 `overloaded` 是可重试错误，但默认重试次数为 0（`dsh-llm-pi-ai` 显式传 `maxRetries: 0`）；
2. 错误冒泡后，其文本不含 `5xx` / `rate limit` / `timeout` 等关键词，被归类为兜底的 `PI_AI_ERROR`——而它**不在** `dsh-llm-retry` 的默认可重试码（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）里，于是整轮直接失败。

在 `~/.dsh/settings.yaml` 中给该 provider 加一段 `retryPolicy`，把 `PI_AI_ERROR` 纳入可重试码即可（重开 session 后生效）：

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
          initialDelayMs: 2000   # 首次重试延迟，指数翻倍
          maxDelayMs: 60000      # 单次延迟上限
          jitterRatio: 0.2       # ±20% 抖动
```

注意区分另一类**必然失败**：部分模型对 ChatGPT 订阅账号不可用，后端直接返回 `400 The '<model>' model is not supported when using Codex with a ChatGPT account.`（实测如 `gpt-5.3-codex-spark`、`gpt-5-codex`）。这类是永久错误，重试无效——请换用账号支持的模型（如 `gpt-5.4` / `gpt-5.5` / `gpt-5.6` 系列）。
