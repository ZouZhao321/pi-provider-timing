import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 追加一行 JSON。单行写入用 O_APPEND，多个 pi 进程同时写不会互相覆盖。
export function appendRecord(file: string, record: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}
