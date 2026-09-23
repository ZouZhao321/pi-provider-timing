// 单次 provider 请求的计时状态机。时间戳与 token 计数由调用方注入，本文件不做任何 IO，便于单测。

export type DeltaKind = 'thinking' | 'output';

export interface SegmentTiming {
  deltas: number;
  generationMs: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
  tokens: number | null;
  tokensPerSecond: number | null;
}

export interface TimingRecord {
  at: string;
  sessionId: string;
  seq: number;
  provider: string;
  model: string;
  thinkingLevel: string;
  stopReason: string;
  errorMessage: string | null;
  timing: {
    payloadAt: number | null;
    responseAt: number | null;
    firstDeltaAt: number | null;
    lastDeltaAt: number | null;
    ttftMs: number | null;
    serverTtftMs: number | null;
    streamMs: number | null;
  };
  tokens: { output: number; reasoning: number | null };
  segments: {
    thinking: SegmentTiming;
    output: SegmentTiming;
    overallTokensPerSecond: number | null;
    interleaved: boolean;
  };
}

export interface BeginInput {
  atMs: number;
  provider: string;
  model: string;
  thinkingLevel: string;
}

export interface FinishInput {
  atMs: number;
  outputTokens: number;
  reasoningTokens: number | undefined;
  stopReason: string;
  errorMessage?: string;
}

interface DeltaStats {
  count: number;
  generationMs: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

interface ActiveRequest {
  seq: number;
  provider: string;
  model: string;
  thinkingLevel: string;
  payloadAtMs: number;
  responseAtMs: number | null;
  firstDeltaAtMs: number | null;
  lastDeltaAtMs: number | null;
  lastDeltaKind: DeltaKind | null;
  switches: number;
  thinking: DeltaStats;
  output: DeltaStats;
}

function emptyDeltaStats(): DeltaStats {
  return { count: 0, generationMs: 0, firstAtMs: null, lastAtMs: null };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// assistantMessageEvent 的 type 到计时分段的映射。非增量事件返回 null。
export function deltaKind(eventType: string): DeltaKind | null {
  if (eventType === 'thinking_delta') return 'thinking';
  if (eventType === 'text_delta' || eventType === 'toolcall_delta') return 'output';
  return null;
}

export interface TrackerDiagnostics {
  onDeltaWithoutRequest(atMs: number): void;
  onTokenMismatch(details: { output: number; reasoning: number }): void;
}

export class RequestTracker {
  private sessionId = 'unknown';
  private seq = 0;
  private active: ActiveRequest | null = null;

  constructor(private readonly diagnostics?: TrackerDiagnostics) {}

  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.seq = 0;
    this.active = null;
  }

  // 请求发出前调用。返回被顶替的旧请求记录（上一个请求没有等到 message_end 时才会出现）。
  beginRequest(input: BeginInput): TimingRecord | null {
    const superseded = this.active
      ? this.buildRecord(this.active, {
          atMs: input.atMs,
          outputTokens: 0,
          reasoningTokens: undefined,
          stopReason: 'superseded',
          errorMessage: 'no message_end before the next provider request',
        })
      : null;

    this.seq += 1;
    this.active = {
      seq: this.seq,
      provider: input.provider,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      payloadAtMs: input.atMs,
      responseAtMs: null,
      firstDeltaAtMs: null,
      lastDeltaAtMs: null,
      lastDeltaKind: null,
      switches: 0,
      thinking: emptyDeltaStats(),
      output: emptyDeltaStats(),
    };
    return superseded;
  }

  // assistant 消息开始时调用。provider 请求钩子没有触发时用消息自身的时间戳兜底，返回是否新建了窗口。
  ensureActive(input: BeginInput): boolean {
    if (this.active) return false;
    this.seq += 1;
    this.active = {
      seq: this.seq,
      provider: input.provider,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      payloadAtMs: input.atMs,
      responseAtMs: null,
      firstDeltaAtMs: null,
      lastDeltaAtMs: null,
      lastDeltaKind: null,
      switches: 0,
      thinking: emptyDeltaStats(),
      output: emptyDeltaStats(),
    };
    return true;
  }

  noteResponse(atMs: number): void {
    if (!this.active) return;
    this.active.responseAtMs = atMs;
  }

  // 增量到达时调用。相邻增量的间隔计入当前增量的分段生成时间，交错流也能正确归集。
  noteDelta(kind: DeltaKind, atMs: number): void {
    const active = this.active;
    if (!active) {
      this.diagnostics?.onDeltaWithoutRequest(atMs);
      return;
    }

    const stats = kind === 'thinking' ? active.thinking : active.output;
    if (active.lastDeltaAtMs !== null) {
      stats.generationMs += Math.max(0, atMs - active.lastDeltaAtMs);
    }
    if (active.lastDeltaKind !== null && active.lastDeltaKind !== kind) {
      active.switches += 1;
    }
    if (stats.firstAtMs === null) stats.firstAtMs = atMs;
    stats.lastAtMs = atMs;
    stats.count += 1;

    if (active.firstDeltaAtMs === null) active.firstDeltaAtMs = atMs;
    active.lastDeltaAtMs = atMs;
    active.lastDeltaKind = kind;
  }

  // assistant 消息结束时调用，产出可写入的记录。
  finish(input: FinishInput): TimingRecord | null {
    const active = this.active;
    if (!active) return null;
    this.active = null;
    return this.buildRecord(active, input);
  }

  get activeSeq(): number | null {
    return this.active ? this.active.seq : null;
  }

  private buildRecord(active: ActiveRequest, input: FinishInput): TimingRecord {
    const firstDeltaAt = active.firstDeltaAtMs;
    const lastDeltaAt = active.lastDeltaAtMs;

    const ttftMs = firstDeltaAt === null ? null : firstDeltaAt - active.payloadAtMs;
    const serverTtftMs =
      firstDeltaAt === null || active.responseAtMs === null
        ? null
        : firstDeltaAt - active.responseAtMs;
    const streamMs =
      firstDeltaAt === null || lastDeltaAt === null ? null : lastDeltaAt - firstDeltaAt;

    // reasoning 是 output 的子集。provider 未上报时不能拆分，两个分段的 token 一律留空。
    let thinkingTokens: number | null = null;
    let visibleTokens: number | null = null;
    const reasoning = input.reasoningTokens;
    if (typeof reasoning === 'number' && Number.isFinite(reasoning)) {
      thinkingTokens = reasoning;
      if (input.outputTokens >= reasoning) {
        visibleTokens = input.outputTokens - reasoning;
      } else {
        visibleTokens = null;
        this.diagnostics?.onTokenMismatch({ output: input.outputTokens, reasoning });
      }
    }

    const overallTokensPerSecond =
      streamMs !== null && streamMs > 0 ? round1(input.outputTokens / (streamMs / 1000)) : null;

    return {
      at: new Date(input.atMs).toISOString(),
      sessionId: this.sessionId,
      seq: active.seq,
      provider: active.provider,
      model: active.model,
      thinkingLevel: active.thinkingLevel,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage ?? null,
      timing: {
        payloadAt: active.payloadAtMs,
        responseAt: active.responseAtMs,
        firstDeltaAt,
        lastDeltaAt,
        ttftMs,
        serverTtftMs,
        streamMs,
      },
      tokens: {
        output: input.outputTokens,
        reasoning: typeof reasoning === 'number' && Number.isFinite(reasoning) ? reasoning : null,
      },
      segments: {
        thinking: this.buildSegment(active.thinking, thinkingTokens),
        output: this.buildSegment(active.output, visibleTokens),
        overallTokensPerSecond,
        interleaved: active.switches >= 2,
      },
    };
  }

  private buildSegment(stats: DeltaStats, tokens: number | null): SegmentTiming {
    const seconds = stats.generationMs / 1000;
    const tokensPerSecond =
      tokens !== null && tokens > 0 && seconds > 0 ? round1(tokens / seconds) : null;

    return {
      deltas: stats.count,
      generationMs: stats.generationMs,
      firstAtMs: stats.firstAtMs,
      lastAtMs: stats.lastAtMs,
      tokens,
      tokensPerSecond,
    };
  }
}
