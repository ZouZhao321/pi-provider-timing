# provider-timing

pi 扩展：记录每次 provider 请求的首 token 延迟与输出速率，追加写入 JSONL 文件。

pi 自身的 usage 只包含 token 计数与成本，没有任何时间量测。内置的 `PI_TIMING=1` 只测启动阶段的耗时，与模型响应无关。本扩展补上这块缺口：在 `before_provider_request`、`after_provider_response`、`message_update`、`message_end` 上打时间戳，按请求产出一条记录。

## 安装与加载

扩展放在 `~/.pi/agent/extensions/provider-timing/`，pi 启动时自动发现。改动源码后执行 `/reload` 或重启 pi 生效，不需要重新安装。`node_modules` 仅供编辑器类型提示与本地检查使用，运行时解析的 `@earendil-works/pi-coding-agent` 由 pi 自己提供。

## 数据文件

```
<agent 目录>/provider-timing/requests.jsonl
```

agent 目录默认是 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 改变。每次 provider 请求追加一行，多个 pi 进程同时写不会互相覆盖。文件只增不减，需要清理时自行处理。

## 记录字段

| 字段                              | 含义                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `at`                              | 记录写入时刻（ISO 8601）                                                           |
| `sessionId`                       | 会话 ID                                                                            |
| `seq`                             | 本会话内的请求序号，从 1 开始                                                      |
| `provider` / `model`              | 请求时的 provider 与模型                                                           |
| `thinkingLevel`                   | 请求时的思考等级                                                                   |
| `stopReason`                      | `stop`、`toolUse`、`length`、`error`、`aborted`，没有等到消息结束时为 `superseded` |
| `errorMessage`                    | 失败原因原文，成功时为 null                                                        |
| `timing.payloadAt`                | payload 构建完成、HTTP 调用之前的时刻，首 token 延迟的起点                         |
| `timing.responseAt`               | 响应头到达的时刻，流尚未消费；provider 不暴露响应时为 null                         |
| `timing.firstDeltaAt`             | 首个增量到达的时刻                                                                 |
| `timing.lastDeltaAt`              | 末个增量到达的时刻                                                                 |
| `timing.ttftMs`                   | `firstDeltaAt - payloadAt`，用户感知的等待                                         |
| `timing.serverTtftMs`             | `firstDeltaAt - responseAt`，扣掉网络与排队后的服务端首 token 时间                 |
| `timing.streamMs`                 | `lastDeltaAt - firstDeltaAt`，流的总跨度                                           |
| `tokens.output`                   | provider 上报的输出 token（含思考）                                                |
| `tokens.reasoning`                | provider 上报的思考 token；未上报时为 null                                         |
| `segments.thinking`               | 思考分段的增量数、生成时间、token 与速率                                           |
| `segments.output`                 | 可见输出分段（正文与工具调用参数）的同组字段                                       |
| `segments.overallTokensPerSecond` | 全部输出 token 除以流的总跨度                                                      |
| `segments.interleaved`            | 思考与输出是否交替出现（思考 → 输出 → 思考）                                       |

## 三种速率的口径

- `segments.thinking.tokensPerSecond` 与 `segments.output.tokensPerSecond` 的分母是**生成时间**：相邻两个增量的间隔，按当前增量的分段归集。首个增量之前的间隔属于首 token 延迟，不计入任何分段。交错流下两个分段互不重叠，因此这两项可以横向比较。
- `segments.overallTokensPerSecond` 的分母是墙上时间跨度 `streamMs`，分子是包含思考在内的全部输出 token。它用于 provider 未上报 `reasoning` 的场合，那里无法拆分 token，只能给整体值。
- 两个分段速率要求 `tokens > 0` 且生成时间大于 0，否则为 null。

## 已知局限

- 首个增量的时刻是扩展收到 `message_update` 的时刻，比 token 真正离开服务端的时刻晚一个事件派发的时间。
- pi-ai 传输层内部的请求重试发生在 `before_provider_request` 之后，该次请求的 `ttftMs` 会包含重试等待；pi 层面的自动重试会重新触发钩子，每次尝试各自成为一条记录。
- 增量数量很少时（例如整段回复只有两个增量），生成时间只有一次间隔，速率是噪声。用 `deltas` 字段过滤样本。
- provider 上报的 token 数与扩展数出的增量数来源不同（tokenizer 对比字符串分块），两者不会严格成比例。

## 统计示例

按 provider 与模型统计首 token 延迟与速率的分布：

```bash
node -e "
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const file = path.join(os.homedir(), '.pi', 'agent', 'provider-timing', 'requests.jsonl');
const rows = fs
  .readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((r) => r.timing.ttftMs !== null);
const key = (r) => r.provider + '/' + r.model;
const groups = new Map();
for (const row of rows) {
  const list = groups.get(key(row)) ?? [];
  list.push(row.timing.ttftMs);
  groups.set(key(row), list);
}
for (const [name, list] of groups) {
  list.sort((a, b) => a - b);
  const pick = (p) => list[Math.min(list.length - 1, Math.floor((p / 100) * list.length))];
  console.log(name, 'n=' + list.length, 'p50=' + pick(50) + 'ms', 'p95=' + pick(95) + 'ms');
}
"
```

## 开发

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
```

隔离测试（只加载本扩展，不读上下文文件，不写会话）：

```bash
pi -ne -nc -e "<本目录绝对路径>" -p "只回答 ok" --no-session
```

`tmp/faux-provider.ts` 是速率计算的定量验证用假 provider，按每块 4 字符、100 tokens/秒 的节奏送出增量；`tmp/event-probe.ts` 把 provider 相关事件的到达顺序写进 `tmp/events.log`。两者都只在用 `-e` 显式加载时生效。
