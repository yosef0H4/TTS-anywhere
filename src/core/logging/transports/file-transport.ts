import fs from "node:fs";
import path from "node:path";
import type { LogEntry, Transport } from "../types";

interface FileTransportOptions {
  maxFileSizeBytes?: number;
  maxFiles?: number;
  baseName?: string;
}

export class FileTransport implements Transport {
  private readonly maxFileSizeBytes: number;
  private readonly maxFiles: number;
  private readonly baseName: string;
  private readonly buffer: string[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private fileSize = 0;

  constructor(private readonly logDir: string, options: FileTransportOptions = {}) {
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.baseName = options.baseName ?? "tts-sniffer.log";
    fs.mkdirSync(this.logDir, { recursive: true });
    try {
      this.fileSize = fs.statSync(this.getLogPath()).size;
    } catch {
      this.fileSize = 0;
    }
    this.timer = setInterval(() => this.flush(), 1000);
  }

  write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    this.buffer.push(line);
    this.fileSize += line.length + 1;
    if (this.fileSize >= this.maxFileSizeBytes) {
      this.flush();
      this.rotate();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const payload = `${this.buffer.join("\n")}\n`;
    this.buffer.length = 0;
    fs.appendFileSync(this.getLogPath(), payload, "utf-8");
  }

  stop(): void {
    clearInterval(this.timer);
    this.flush();
  }

  clearLogs(): void {
    this.flush();
    const basePath = this.getLogPath();
    if (fs.existsSync(basePath)) fs.unlinkSync(basePath);
    for (let i = 1; i <= this.maxFiles; i += 1) {
      const p = `${basePath}.${i}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    this.fileSize = 0;
  }

  getLogPath(): string {
    return path.join(this.logDir, this.baseName);
  }

  private rotate(): void {
    const basePath = this.getLogPath();
    const oldest = `${basePath}.${this.maxFiles}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const from = `${basePath}.${i}`;
      const to = `${basePath}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(basePath)) fs.renameSync(basePath, `${basePath}.1`);
    this.fileSize = 0;
  }
}
