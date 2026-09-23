import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendLine, appendRecord, writeRecordOrLog } from './writer.ts';

const tmpRoot = fileURLToPath(new URL('../tmp/', import.meta.url));

// 追加写入的目标不能在多次运行之间共用，否则上一次的残留会让断言失败。
const runId = `${process.pid}-${Date.now()}`;

describe('appendLine', () => {
  it('自动创建目录并按顺序追加', () => {
    const file = join(tmpRoot, 'writer-test', `out-${runId}.log`);
    appendLine(file, 'first\n');
    appendLine(file, 'second\n');
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n');
  });
});

describe('appendRecord', () => {
  it('每个对象写成一行 JSON', () => {
    const file = join(tmpRoot, 'writer-test', `records-${runId}.jsonl`);
    appendRecord(file, { seq: 1 });
    appendRecord(file, { seq: 2 });
    expect(readFileSync(file, 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');
  });
});

describe('writeRecordOrLog', () => {
  it('目标无法写入时先交出诊断，再重新抛出原错误', () => {
    const asDirectory = join(tmpRoot, 'writer-test-target-dir');
    mkdirSync(asDirectory, { recursive: true });
    const failures: { file: string; error: string }[] = [];

    expect(() =>
      writeRecordOrLog({
        file: asDirectory,
        record: { seq: 1 },
        logError: (details) => failures.push(details),
      }),
    ).toThrow();

    expect(failures).toHaveLength(1);
    expect(failures[0].file).toBe(asDirectory);
    expect(failures[0].error).toMatch(/EISDIR|EPERM|EACCES|illegal operation/i);
  });
});
