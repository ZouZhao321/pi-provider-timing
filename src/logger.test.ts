import { describe, expect, it } from 'vitest';
import { createLogger, formatLogLine } from './logger.ts';

describe('formatLogLine', () => {
  it('输出 ISO 时刻、级别、消息与 JSON 细节', () => {
    expect(formatLogLine('INFO', 'loaded', 0, { pid: 1 })).toBe(
      '1970-01-01T00:00:00.000Z INFO  loaded {"pid":1}\n',
    );
  });

  it('没有细节时不追加 JSON', () => {
    expect(formatLogLine('WARN', 'delta-without-request', 0)).toBe(
      '1970-01-01T00:00:00.000Z WARN  delta-without-request\n',
    );
  });

  it('细节为空对象时同样不追加 JSON', () => {
    expect(formatLogLine('ERROR', 'write-failed', 0, {})).toBe(
      '1970-01-01T00:00:00.000Z ERROR write-failed\n',
    );
  });
});

describe('createLogger', () => {
  it('默认级别下丢弃 DEBUG，保留 INFO 与以上', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), debug: false, now: () => 0 });

    log.debug('delta', { kind: 'output' });
    log.info('loaded');
    log.warn('window-fallback');
    log.error('write-failed');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('INFO  loaded');
    expect(lines[1]).toContain('WARN  window-fallback');
    expect(lines[2]).toContain('ERROR write-failed');
  });

  it('debug 打开时输出 DEBUG 行', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), debug: true, now: () => 0 });

    log.debug('delta', { kind: 'thinking' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('1970-01-01T00:00:00.000Z DEBUG delta {"kind":"thinking"}\n');
  });
});
