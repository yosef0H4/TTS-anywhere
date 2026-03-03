import { LOG_LEVEL_PRIORITY, type LogEntry, type LogLevel, type LoggerConfig, type Transport } from "./types";

let globalSource: "frontend" | "backend" = "frontend";
let globalLevel: LogLevel = "info";
let sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const transports: Transport[] = [];

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[globalLevel];
}

function emit(level: LogLevel, category: string, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    context,
    source: globalSource,
    sessionId
  };
  for (const t of transports) {
    try {
      t.write(entry);
    } catch {
      // keep app alive even if one transport fails
    }
  }
}

export class Logger {
  constructor(private readonly category: string) {}

  debug(message: string, context?: Record<string, unknown>): void {
    emit("debug", this.category, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    emit("info", this.category, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    emit("warn", this.category, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    emit("error", this.category, message, context);
  }

  time(label: string): () => void {
    const start = performance.now();
    return () => this.debug(`${label} completed`, { durationMs: Number((performance.now() - start).toFixed(2)) });
  }
}

export function initializeLogger(config: LoggerConfig): void {
  globalSource = config.source;
  globalLevel = config.level;
}

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

export function addTransport(transport: Transport): void {
  transports.push(transport);
}

export function removeTransport(transport: Transport): void {
  const idx = transports.indexOf(transport);
  if (idx >= 0) transports.splice(idx, 1);
}

export function clearTransports(): void {
  for (const t of transports.splice(0, transports.length)) {
    try {
      t.stop?.();
    } catch {
      // ignore
    }
  }
}

export function flushTransports(): void {
  for (const t of transports) {
    try {
      t.flush?.();
    } catch {
      // ignore
    }
  }
}

export function createCategoryLogger(category: string): Logger {
  return new Logger(category);
}

export function getSessionId(): string {
  return sessionId;
}

export const loggers = {
  app: createCategoryLogger("app"),
  tts: createCategoryLogger("tts"),
  ocr: createCategoryLogger("ocr"),
  capture: createCategoryLogger("capture"),
  playback: createCategoryLogger("playback"),
  settings: createCategoryLogger("settings"),
  api: createCategoryLogger("api"),
  pipeline: createCategoryLogger("pipeline"),
  electron: createCategoryLogger("electron")
};
