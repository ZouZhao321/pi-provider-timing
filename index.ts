// provider-timing 扩展入口：记录每次 provider 请求的首 token 延迟与输出速率，追加写入 JSONL。
// 数据文件：<agent 目录>/provider-timing/requests.jsonl
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { RequestTracker, deltaKind } from './src/tracker.ts';
import { appendRecord } from './src/writer.ts';

function recordsPath(): string {
  return join(getAgentDir(), 'provider-timing', 'requests.jsonl');
}

export default function (pi: ExtensionAPI) {
  const tracker = new RequestTracker();

  pi.on('session_start', (_event, ctx) => {
    tracker.reset(ctx.sessionManager.getSessionId());
  });

  // 请求发出前：payload 构建完成、HTTP 调用之前的时刻，作为首 token 延迟的起点。
  pi.on('before_provider_request', (_event, ctx) => {
    const superseded = tracker.beginRequest({
      atMs: Date.now(),
      provider: ctx.model?.provider ?? 'unknown',
      model: ctx.model?.id ?? 'unknown',
      thinkingLevel: ctx.thinkingLevel ?? 'off',
    });
    if (superseded) appendRecord(recordsPath(), superseded);
  });

  // 响应头到达、流消费之前：用于把首 token 延迟拆成网络排队与服务端生成两段。
  pi.on('after_provider_response', () => {
    tracker.noteResponse(Date.now());
  });

  // 兜底：请求钩子没有触发时，用 assistant 消息自身的时间戳建立请求窗口。
  pi.on('message_start', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    tracker.ensureActive({
      atMs: event.message.timestamp,
      provider: event.message.provider,
      model: event.message.model,
      thinkingLevel: ctx.thinkingLevel ?? 'off',
    });
  });

  pi.on('message_update', (event) => {
    const kind = deltaKind(event.assistantMessageEvent.type);
    if (kind) tracker.noteDelta(kind, Date.now());
  });

  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return;
    const message = event.message;
    const record = tracker.finish({
      atMs: Date.now(),
      outputTokens: message.usage.output,
      reasoningTokens: message.usage.reasoning,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });
    if (record) appendRecord(recordsPath(), record);
  });
}
