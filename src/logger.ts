// 诊断日志：默认只记加载、会话开始与异常路径；PI_PROVIDER_TIMING_DEBUG=1 时追加逐事件细节。
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogDetails = Record<string, unknown>;

export type LogSink = (line: string) => void;

export function formatLogLine(
  level: LogLevel,
  message: string,
  atMs: number,
  details?: LogDetails,
): string {
  const at = new Date(atMs).toISOString();
  const hasDetails = details !== undefined && Object.keys(details).length > 0;
  const suffix = hasDetails ? ` ${JSON.stringify(details)}` : '';
  return `${at} ${level.padEnd(5)} ${message}${suffix}\n`;
}

export interface Logger {
  debug(message: string, details?: LogDetails): void;
  info(message: string, details?: LogDetails): void;
  warn(message: string, details?: LogDetails): void;
  error(message: string, details?: LogDetails): void;
}

export interface LoggerOptions {
  sink: LogSink;
  debug: boolean;
  now?: () => number;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? Date.now;

  const emit = (level: LogLevel, message: string, details?: LogDetails): void => {
    if (level === 'DEBUG' && !options.debug) return;
    options.sink(formatLogLine(level, message, now(), details));
  };

  return {
    debug: (message, details) => emit('DEBUG', message, details),
    info: (message, details) => emit('INFO', message, details),
    warn: (message, details) => emit('WARN', message, details),
    error: (message, details) => emit('ERROR', message, details),
  };
}
