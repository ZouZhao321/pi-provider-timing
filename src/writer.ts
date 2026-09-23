import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 追加一行文本。单行写入用 O_APPEND，多个 pi 进程同时写不会互相覆盖。
export function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line, 'utf8');
}

export function appendRecord(file: string, record: unknown): void {
  appendLine(file, `${JSON.stringify(record)}\n`);
}

export type WriteFailure = {
  file: string;
  error: string;
};

// 写入失败时先交出一条诊断，再重新抛出原错误：错误照常向上传播，不被掩盖在这里。
export function writeRecordOrLog<T>(options: {
  file: string;
  record: T;
  logError: (details: WriteFailure) => void;
}): void {
  try {
    appendRecord(options.file, options.record);
  } catch (error) {
    options.logError({
      file: options.file,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
