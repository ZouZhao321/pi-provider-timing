// provider-timing 扩展入口：记录每次 provider 请求的首 token 延迟与输出速率，追加写入 JSONL。
// 数据文件：<agent 目录>/provider-timing/requests.jsonl
// 诊断日志：<agent 目录>/provider-timing/plugin.log（PI_PROVIDER_TIMING_DEBUG=1 时追加逐事件细节）
import { VERSION, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { createLogger, type Logger } from './logger.ts';
import { RequestTracker, deltaKind, type TimingRecord } from './tracker.ts';
import { appendLine, writeRecordOrLog } from './writer.ts';

const DATA_DIR = 'provider-timing';

function dataFile(name: string): string {
  return join(getAgentDir(), DATA_DIR, name);
}

export default function (pi: ExtensionAPI) {
  const log: Logger = createLogger({
    sink: (line) => appendLine(dataFile('plugin.log'), line),
    debug: process.env.PI_PROVIDER_TIMING_DEBUG === '1',
  });

  const tracker = new RequestTracker({
    onDeltaWithoutRequest: (atMs) => log.warn('delta-without-request', { atMs }),
    onTokenMismatch: (details) => log.warn('token-mismatch', details),
  });

  const writeRecord = (record: TimingRecord): void => {
    writeRecordOrLog({
      file: dataFile('requests.jsonl'),
      record,
      logError: (details) => log.error('write-failed', details),
    });
  };

  log.info('loaded', { pid: process.pid, pi: VERSION, agentDir: getAgentDir() });

  pi.on('session_start', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    tracker.reset(sessionId);
    log.info('session-start', { sessionId, mode: ctx.mode });
  });

  // 请求发出前：payload 构建完成、HTTP 调用之前的时刻，作为首 token 延迟的起点。
  pi.on('before_provider_request', (_event, ctx) => {
    log.debug('event', { type: 'before_provider_request' });
    const superseded = tracker.beginRequest({
      atMs: Date.now(),
      provider: ctx.model?.provider ?? 'unknown',
      model: ctx.model?.id ?? 'unknown',
      thinkingLevel: ctx.thinkingLevel ?? 'off',
    });
    if (superseded) {
      log.warn('request-superseded', {
        seq: superseded.seq,
        provider: superseded.provider,
        model: superseded.model,
      });
      writeRecord(superseded);
    }
    log.debug('request-begin', { seq: tracker.activeSeq });
  });

  // 响应头到达、流消费之前：用于把首 token 延迟拆成网络排队与服务端生成两段。
  pi.on('after_provider_response', () => {
    log.debug('event', { type: 'after_provider_response' });
    tracker.noteResponse(Date.now());
  });

  // 兜底：请求钩子没有触发时，用 assistant 消息自身的时间戳建立请求窗口。
  pi.on('message_start', (event, ctx) => {
    log.debug('event', { type: 'message_start', role: event.message.role });
    if (event.message.role !== 'assistant') return;

    const created = tracker.ensureActive({
      atMs: event.message.timestamp,
      provider: event.message.provider,
      model: event.message.model,
      thinkingLevel: ctx.thinkingLevel ?? 'off',
    });
    if (created) {
      log.info('window-fallback', {
        provider: event.message.provider,
        model: event.message.model,
      });
    }
  });

  pi.on('message_update', (event) => {
    const kind = deltaKind(event.assistantMessageEvent.type);
    if (!kind) return;
    log.debug('delta', { kind, eventType: event.assistantMessageEvent.type });
    tracker.noteDelta(kind, Date.now());
  });

  pi.on('message_end', (event) => {
    log.debug('event', { type: 'message_end', role: event.message.role });
    if (event.message.role !== 'assistant') return;

    const message = event.message;
    const record = tracker.finish({
      atMs: Date.now(),
      outputTokens: message.usage.output,
      reasoningTokens: message.usage.reasoning,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });
    if (!record) return;

    log.debug('request-end', {
      seq: record.seq,
      stopReason: record.stopReason,
      ttftMs: record.timing.ttftMs,
      thinkingTokensPerSecond: record.segments.thinking.tokensPerSecond,
      outputTokensPerSecond: record.segments.output.tokensPerSecond,
    });
    writeRecord(record);
  });
}
