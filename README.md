# pi-provider-timing

[中文](./README.zh.md) | [English](./README.md)

A pi extension that records the first-token latency and output rate of every provider request, appended to a JSONL file.

## Install

Install from npm:

```bash
pi install npm:pi-provider-timing
```

Or install straight from the repository:

```bash
pi install git:github.com/ZouZhao321/pi-provider-timing
```

For local development, install from a checkout directory instead:

```bash
pi install ./provider-timing
```

Alternatively, keep the directory at `~/.pi/agent/extensions/provider-timing/`; pi discovers it automatically on start. After editing the source, run `/reload` or restart pi — no reinstall needed. `node_modules` is only used for editor type hints and local checks; the `@earendil-works/pi-coding-agent` resolved at runtime is the one pi itself provides.

## What it does

pi's own usage only contains token counts and cost, with no timing measurement at all. The built-in `PI_TIMING=1` only measures startup phases and has nothing to do with model responses. This extension fills that gap: it timestamps `before_provider_request`, `after_provider_response`, `message_start`, `message_update` and `message_end`, and emits one record per request. It also listens to `session_start` to capture the session ID. It registers no tools and no commands.

## Configuration

### Data file

```
<agent dir>/provider-timing/requests.jsonl
```

The agent dir defaults to `~/.pi/agent` and can be changed with `PI_CODING_AGENT_DIR`. Every provider request appends one line; multiple pi processes writing at the same time do not overwrite each other. The file only grows — clean it up yourself when needed.

### Logs

The diagnostic log is written to `<agent dir>/provider-timing/plugin.log`, next to the data file. By default it only records extension load, session start, error paths and write failures, so a normal session produces exactly two lines:

```
2026-09-23T08:52:49.296Z INFO  loaded {"pid":22296,"pi":"0.84.2","agentDir":"C:\\Users\\ZouZhao\\.pi\\agent"}
2026-09-23T08:52:49.491Z INFO  session-start {"sessionId":"01a0cd77-b2c8-7d07-91cc-b8f98dfa0580","mode":"print"}
```

With `PI_PROVIDER_TIMING_DEBUG=1` set, every event, every request begin/end and every delta is appended as well:

```
2026-09-23T08:53:08.546Z DEBUG event {"type":"before_provider_request"}
2026-09-23T08:53:08.547Z DEBUG request-begin {"seq":1}
2026-09-23T08:53:15.751Z DEBUG delta {"kind":"output","eventType":"text_delta"}
2026-09-23T08:53:15.755Z DEBUG request-end {"seq":1,"stopReason":"stop","ttftMs":6991,"thinkingTokensPerSecond":64.2,"outputTokensPerSecond":272.7}
```

| Message                 | Level | Meaning                                                                                                             |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| `loaded`                | INFO  | The extension factory ran — answers "was the extension loaded at all"                                               |
| `session-start`         | INFO  | Session start, recording the run mode and the session ID                                                            |
| `window-fallback`       | INFO  | `before_provider_request` did not fire, so this request's `payloadAt` comes from the message's own timestamp        |
| `delta-without-request` | WARN  | A delta arrived while no request was active                                                                         |
| `token-mismatch`        | WARN  | `reasoning` is greater than `output`, so the per-segment tokens of that record are left empty                       |
| `request-superseded`    | WARN  | The previous request was replaced before its `message_end`, and a record with `stopReason: "superseded"` is written |
| `write-failed`          | ERROR | Writing `requests.jsonl` failed; carries the file name and the original error, then rethrows that error             |

Logs are never rotated. At the default level growth is extremely slow; `PI_PROVIDER_TIMING_DEBUG=1` is a temporary troubleshooting switch — turn it off when done. The log never writes to stdout/stderr, so it cannot pollute print or json mode output.

### Record fields

| Field                             | Meaning                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `at`                              | Time the record was written (ISO 8601)                                                                  |
| `sessionId`                       | Session ID                                                                                              |
| `seq`                             | Request ordinal within this session, starting at 1                                                      |
| `provider` / `model`              | Provider and model used for the request                                                                 |
| `thinkingLevel`                   | Thinking level used for the request                                                                     |
| `stopReason`                      | `stop`, `toolUse`, `length`, `error`, `aborted`, or `superseded` when the message end never arrived     |
| `errorMessage`                    | Verbatim failure reason, null on success                                                                |
| `timing.payloadAt`                | Moment the payload was built, before the HTTP call — the start of the first-token latency               |
| `timing.responseAt`               | Moment the response headers arrived, stream not yet consumed; null when the provider does not expose it |
| `timing.firstDeltaAt`             | Moment the first delta arrived                                                                          |
| `timing.lastDeltaAt`              | Moment the last delta arrived                                                                           |
| `timing.ttftMs`                   | `firstDeltaAt - payloadAt`, the wait the user perceives                                                 |
| `timing.serverTtftMs`             | `firstDeltaAt - responseAt`, the server-side first-token time after subtracting network and queueing    |
| `timing.streamMs`                 | `lastDeltaAt - firstDeltaAt`, the total span of the stream                                              |
| `tokens.output`                   | Output tokens reported by the provider (including thinking)                                             |
| `tokens.reasoning`                | Thinking tokens reported by the provider; null when not reported                                        |
| `segments.thinking`               | Delta count, generation time, tokens and rate of the thinking segment                                   |
| `segments.output`                 | The same group of fields for the visible output segment (body text and tool-call arguments)             |
| `segments.overallTokensPerSecond` | All output tokens divided by the total span of the stream                                               |
| `segments.interleaved`            | Whether thinking and output alternated (thinking → output → thinking)                                   |

### The three rate definitions

- The denominator of `segments.thinking.tokensPerSecond` and `segments.output.tokensPerSecond` is **generation time**: the gap between two adjacent deltas, attributed to the segment of the current delta. The gap before the first delta belongs to the first-token latency and is not counted in any segment. In an interleaved stream the two segments never overlap, so these two values are comparable with each other.
- The denominator of `segments.overallTokensPerSecond` is the wall-clock span `streamMs`, and the numerator is all output tokens including thinking. It exists for cases where the provider does not report `reasoning` and tokens therefore cannot be split.
- Both segment rates require `tokens > 0` and generation time greater than 0, otherwise they are null.

### Known limitations

- The time of the first delta is when the extension receives `message_update`, which is one event dispatch later than the moment the token actually left the server.
- Request retries inside the pi-ai transport layer happen after `before_provider_request`, so that request's `ttftMs` includes the retry wait; automatic retries at the pi layer re-fire the hooks, making each attempt its own record.
- With very few deltas (for example a reply that arrives in only two deltas) there is a single gap, and the rate is noise. Filter samples by the `deltas` field.
- The token count reported by the provider and the delta count computed by the extension come from different sources (tokenizer versus string chunking), so the two are not strictly proportional.

### Statistics example

Distribution of first-token latency and rate per provider and model:

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

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
```

Available scripts: `lint` (`eslint . --ext .ts`), `lint:fix` (`eslint . --ext .ts --fix`), `format` (`prettier --write .`), `format:check` (`prettier --check .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`).

Isolated test run (loads only this extension, reads no context files, writes no session):

```bash
pi -ne -nc -e "<absolute path to this directory>" -p "只回答 ok" --no-session
```

`tmp/faux-provider.ts` is a fake provider for quantitative verification of the rate math: it emits deltas at 4 characters per chunk and 100 tokens/second. `tmp/event-probe.ts` writes the arrival order of provider-related events to `tmp/events.log`. Both only take effect when explicitly loaded with `-e`.

## License

MIT — see [LICENSE](./LICENSE).
