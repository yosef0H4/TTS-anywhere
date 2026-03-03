export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  source: "frontend" | "backend";
  sessionId?: string | undefined;
}

export interface LoggerConfig {
  source: "frontend" | "backend";
  level: LogLevel;
}

export interface LoggingConfig {
  level: LogLevel;
  enableFileLogging: boolean;
  enableConsoleLogging: boolean;
}

export interface Transport {
  write(entry: LogEntry): void;
  flush?(): void;
  stop?(): void;
}

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
