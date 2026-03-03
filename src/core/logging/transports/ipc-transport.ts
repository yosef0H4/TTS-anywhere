import { IPC_CHANNELS } from "../ipc-channels";
import type { LogEntry, Transport } from "../types";

export class IpcTransport implements Transport {
  private readonly buffer: LogEntry[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly batchSize = 50, private readonly intervalMs = 500) {
    this.timer = setInterval(() => this.flush(), intervalMs);
  }

  write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const entries = this.buffer.splice(0, this.buffer.length);
    window.electronAPI?.sendLogEntries?.(entries);
  }

  stop(): void {
    clearInterval(this.timer);
    this.flush();
  }
}
