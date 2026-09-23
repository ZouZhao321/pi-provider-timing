import { describe, expect, it } from 'vitest';
import { RequestTracker, deltaKind } from './tracker.ts';

describe('deltaKind', () => {
  it('把增量事件映射到计时分段', () => {
    expect(deltaKind('thinking_delta')).toBe('thinking');
    expect(deltaKind('text_delta')).toBe('output');
    expect(deltaKind('toolcall_delta')).toBe('output');
  });

  it('非增量事件不计入分段', () => {
    for (const type of [
      'start',
      'text_start',
      'text_end',
      'thinking_start',
      'thinking_end',
      'toolcall_start',
      'toolcall_end',
      'done',
      'error',
    ]) {
      expect(deltaKind(type)).toBeNull();
    }
  });
});

describe('RequestTracker', () => {
  it('普通文本输出：首 token 延迟、分段生成时间与速率', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    expect(
      tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'off' }),
    ).toBeNull();
    tracker.noteResponse(1100);
    tracker.noteDelta('output', 1300);
    tracker.noteDelta('output', 1400);
    tracker.noteDelta('output', 1500);

    const record = tracker.finish({
      atMs: 1600,
      outputTokens: 20,
      reasoningTokens: 0,
      stopReason: 'stop',
    });

    expect(record).not.toBeNull();
    expect(record!.timing.ttftMs).toBe(300);
    expect(record!.timing.serverTtftMs).toBe(200);
    expect(record!.timing.streamMs).toBe(200);
    expect(record!.tokens).toEqual({ output: 20, reasoning: 0 });
    expect(record!.segments.thinking.tokens).toBe(0);
    expect(record!.segments.thinking.tokensPerSecond).toBeNull();
    expect(record!.segments.output.generationMs).toBe(200);
    expect(record!.segments.output.tokens).toBe(20);
    expect(record!.segments.output.tokensPerSecond).toBe(100);
    expect(record!.segments.overallTokensPerSecond).toBe(100);
    expect(record!.segments.interleaved).toBe(false);
  });

  it('思考与正文交错：生成时间按分段归集，速率互不污染', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'high' });
    tracker.noteDelta('thinking', 1200);
    tracker.noteDelta('thinking', 1300);
    tracker.noteDelta('thinking', 1400);
    tracker.noteDelta('output', 1500);
    tracker.noteDelta('output', 1600);
    tracker.noteDelta('thinking', 1700);
    tracker.noteDelta('output', 1800);

    const record = tracker.finish({
      atMs: 1900,
      outputTokens: 100,
      reasoningTokens: 40,
      stopReason: 'stop',
    });

    expect(record!.timing.ttftMs).toBe(200);
    expect(record!.timing.streamMs).toBe(600);
    expect(record!.segments.thinking.tokens).toBe(40);
    expect(record!.segments.thinking.generationMs).toBe(300);
    expect(record!.segments.thinking.tokensPerSecond).toBe(133.3);
    expect(record!.segments.output.tokens).toBe(60);
    expect(record!.segments.output.generationMs).toBe(300);
    expect(record!.segments.output.tokensPerSecond).toBe(200);
    expect(record!.segments.overallTokensPerSecond).toBe(166.7);
    expect(record!.segments.interleaved).toBe(true);
  });

  it('provider 未上报 reasoning 时不拆分 token，只给整体速率', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'medium' });
    tracker.noteDelta('thinking', 1200);
    tracker.noteDelta('thinking', 1300);
    tracker.noteDelta('output', 1400);

    const record = tracker.finish({
      atMs: 1500,
      outputTokens: 50,
      reasoningTokens: undefined,
      stopReason: 'stop',
    });

    expect(record!.tokens.reasoning).toBeNull();
    expect(record!.segments.thinking.tokens).toBeNull();
    expect(record!.segments.thinking.tokensPerSecond).toBeNull();
    expect(record!.segments.output.tokens).toBeNull();
    expect(record!.segments.output.tokensPerSecond).toBeNull();
    expect(record!.segments.output.generationMs).toBe(100);
    expect(record!.segments.overallTokensPerSecond).toBe(250);
  });

  it('没有任何增量时记录失败原因，延迟字段留空', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'off' });

    const record = tracker.finish({
      atMs: 1500,
      outputTokens: 0,
      reasoningTokens: 0,
      stopReason: 'error',
      errorMessage: 'OpenAI API error (429)',
    });

    expect(record!.stopReason).toBe('error');
    expect(record!.errorMessage).toBe('OpenAI API error (429)');
    expect(record!.timing.ttftMs).toBeNull();
    expect(record!.timing.streamMs).toBeNull();
    expect(record!.segments.overallTokensPerSecond).toBeNull();
  });

  it('reasoning 大于 output 这类矛盾数据下不给出正文 token', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'high' });
    tracker.noteDelta('output', 1200);

    const record = tracker.finish({
      atMs: 1300,
      outputTokens: 10,
      reasoningTokens: 30,
      stopReason: 'stop',
    });

    expect(record!.segments.thinking.tokens).toBe(30);
    expect(record!.segments.output.tokens).toBeNull();
  });

  it('上一个请求没有收尾时，新请求把旧请求记为 superseded', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'off' });
    tracker.noteDelta('output', 1200);

    const superseded = tracker.beginRequest({
      atMs: 2000,
      provider: 'p2',
      model: 'm2',
      thinkingLevel: 'off',
    });

    expect(superseded!.seq).toBe(1);
    expect(superseded!.stopReason).toBe('superseded');
    expect(superseded!.provider).toBe('p');
    expect(tracker.activeSeq).toBe(2);
  });

  it('兜底建立请求窗口，已有活跃请求时不被覆盖', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    expect(tracker.activeSeq).toBeNull();

    tracker.ensureActive({ atMs: 500, provider: 'p', model: 'm', thinkingLevel: 'off' });
    tracker.ensureActive({ atMs: 900, provider: 'other', model: 'other', thinkingLevel: 'off' });
    expect(tracker.activeSeq).toBe(1);

    tracker.noteDelta('output', 700);
    const record = tracker.finish({
      atMs: 800,
      outputTokens: 10,
      reasoningTokens: 0,
      stopReason: 'stop',
    });

    expect(record!.timing.payloadAt).toBe(500);
    expect(record!.timing.ttftMs).toBe(200);
    expect(record!.provider).toBe('p');
  });

  it('没有活跃请求时不产生记录，也不抛错', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.noteDelta('output', 100);
    tracker.noteResponse(100);
    expect(
      tracker.finish({ atMs: 200, outputTokens: 5, reasoningTokens: 0, stopReason: 'stop' }),
    ).toBeNull();
  });

  it('reset 清空会话内的序号与活跃请求', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'off' });
    tracker.reset('s2');

    expect(tracker.activeSeq).toBeNull();
    tracker.beginRequest({ atMs: 2000, provider: 'p', model: 'm', thinkingLevel: 'off' });
    const record = tracker.finish({
      atMs: 2100,
      outputTokens: 1,
      reasoningTokens: 0,
      stopReason: 'stop',
    });

    expect(record!.seq).toBe(1);
    expect(record!.sessionId).toBe('s2');
  });
});

describe('RequestTracker 诊断回调', () => {
  const noop = () => {};

  it('ensureActive 返回是否新建了窗口', () => {
    const tracker = new RequestTracker();
    tracker.reset('s1');
    expect(
      tracker.ensureActive({ atMs: 500, provider: 'p', model: 'm', thinkingLevel: 'off' }),
    ).toBe(true);
    expect(
      tracker.ensureActive({ atMs: 600, provider: 'p', model: 'm', thinkingLevel: 'off' }),
    ).toBe(false);
  });

  it('没有活跃请求时收到增量会报告出来', () => {
    const seen: number[] = [];
    const tracker = new RequestTracker({
      onDeltaWithoutRequest: (atMs) => seen.push(atMs),
      onTokenMismatch: noop,
    });
    tracker.reset('s1');

    tracker.noteDelta('output', 123);

    expect(seen).toEqual([123]);
  });

  it('reasoning 大于 output 时报告矛盾数据', () => {
    const mismatches: { output: number; reasoning: number }[] = [];
    const tracker = new RequestTracker({
      onDeltaWithoutRequest: noop,
      onTokenMismatch: (details) => mismatches.push(details),
    });
    tracker.reset('s1');
    tracker.beginRequest({ atMs: 1000, provider: 'p', model: 'm', thinkingLevel: 'high' });
    tracker.noteDelta('output', 1200);

    tracker.finish({ atMs: 1300, outputTokens: 10, reasoningTokens: 30, stopReason: 'stop' });

    expect(mismatches).toEqual([{ output: 10, reasoning: 30 }]);
  });
});
