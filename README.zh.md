# dsh-session-header

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 harness 发出的**每一个 LLM 请求**注入 `x-session-id` header，值为**发起该次调用的 harness session id**。

## 为什么需要它

harness 没有请求级 header 缝——`GenerateOptions` 没有 headers 字段，每个 adapter 都在自己内部构造线上 header。如果你的模型网关（或中间代理）按 session header 做路由、缓存或审计，harness 自身发不出这个 header。

本插件把两个官方拦截点组合起来补上这个缺口：

- **`llm/stream` waterfall** 标记出哪些调用是 LLM 调用，并携带 `options.sessionId`；
- **`globalThis.fetch` 补丁** 注入 header，所有基于 fetch 的 adapter（`llm-deepseek`、`llm-pi-ai`，以及任何传输层最终落在全局 fetch 上的 SDK）都被覆盖，无需改 adapter 代码。

上下文传播用 `AsyncLocalStorage`：只有发生在某次 LLM 调用流内部的 fetch 会被触碰，无关 fetch（web RPC、遥测、工具流量）原样通过。别人已设置的 header 绝不覆盖（按 HTTP 语义大小写不敏感）。插件卸载时还原原始 `fetch`。

取值语义：

- 默认：取当前调用 `GenerateOptions.sessionId`，并剥掉 harness 的 `session-` 品牌前缀（发送纯 UUID）——主会话各轮次、压缩/起标题辅助调用、in-process 子 agent 各自上报**自己的** session id（子 agent 拥有独立的 child session id）；
- 配置 `value`：所有调用使用固定值（按配置原样发送，不剥前缀）；
- 两者皆无的调用不发这个 header。

## 安装

需要 `dsh` CLI 与 Node ≥ 22。

### 作为 bundle 安装（推荐）

```sh
dsh plugin --profile <name> add github:homily707/dsh-session-header
```

本包是纯 JavaScript、无构建脚本，不需要 pnpm ≥ 10 的构建授权。验证层并启动：

```sh
dsh --profile <name> --dump-config   # 应能看到 "# == dsh-session-header" 层
dsh --profile <name>
```

### 本地 checkout 用 `--patch` 覆盖层加载

```yaml
# my-overlay.yml —— 此处插件行需要绝对模块路径
- insert:
    - id: session-header
      name: /absolute/path/to/dsh-session-header/index.js
      config:
        header: x-session-id
        # value: my-fixed-session-id
```

```sh
dsh --patch ./my-overlay.yml
```

## 配置

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `header` | string | `x-session-id` | 注入的 header 名；线上大小写不敏感 |
| `value` | string | — | 固定值；不设 = 取当前调用的 harness session id |
| `toolEndpoints` | string[] | `[]` | 工具执行期匹配的 URL 前缀。非空时，`tools/execute` 瀑布内的 fetch（例如工具里调用的网关 web-search Messages API）仅当 URL 以某前缀开头才注入 header——第三方工具目标（web_fetch 抓任意网页、GitHub、MCP 服务器等）不受影响。默认空 = 保持原有仅 LLM 注入行为 |
| `overwriteHeaders` | string[] | `[]` | 允许本插件**覆盖**已有值的 header 名列表；未列出的头仍遵守"不覆盖"规则。某些官方 provider 会硬编码占位值（如 `dsh-web-search-deepseek` 发送 `x-opencode-session: dsh-web-search`），网关会当作缺失拒绝；把该头列入（`overwriteHeaders: [x-opencode-session]`）即可用真实的会话 id 替换占位值。大小写不敏感。 |

## 验证

把某个 provider 的 `baseURL` 指向会记录请求 header 的网关（或任何回显请求头的端点），开一个会话：

```
x-session-id: ba104306-a748-4052-a6e3-ab60be2e4c1f
```

同一会话的所有请求带同一 id；spawn 出的子 agent 的请求带 child session id。

## 说明

- `llm-deepseek` adapter 自身每次请求已带 `x-deepseek-harness-session-id`；本插件是 provider 中立的，且刻意不覆盖已有 header。
- 绝不触碰 `attributionHeaders()`（harness 的 User-Agent 归因契约）。
- 并发会话正确处理：header 值按调用经由 AsyncLocalStorage 解析，不经过共享可变状态。

## 许可

[MIT](LICENSE)
