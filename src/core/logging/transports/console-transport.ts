import type { LogEntry, Transport } from "../types";

export class ConsoleTransport implements Transport {
  write(entry: LogEntry): void {
    const line = `[${entry.timestamp}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.category}] ${entry.message}`;
    const payload = entry.context ? `${line} ${JSON.stringify(entry.context)}` : line;
    if (entry.level === "error") console.error(payload);
    else if (entry.level === "warn") console.warn(payload);
    else if (entry.level === "debug") console.debug(payload);
    else console.info(payload);
  }
}
