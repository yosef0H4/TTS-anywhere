export interface TtsResponseFormatConfig {
  model: string;
  format: "mp3" | "wav" | "opus";
}

export type ThinkingMode = "provider_default" | "low" | "off";

export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function completedTtsResponseFormat(config: TtsResponseFormatConfig): "mp3" | "wav" | "opus" {
  const model = config.model.trim().toLowerCase();
  if (
    model === "kokoro" ||
    model === "supertone/supertonic-3" ||
    model.startsWith("piper") ||
    model.startsWith("kitten") ||
    model === "windows-natural" ||
    model.startsWith("windows-natural:")
  ) {
    return "wav";
  }
  if (model === "edge" || model.startsWith("edge-")) {
    return "mp3";
  }
  return config.format;
}

export function resolveReasoningEffort(model: string, thinkingMode: ThinkingMode | undefined): "none" | "low" | null {
  const normalized = model.trim().toLowerCase();
  if (thinkingMode === "off") {
    return normalized.includes("gemini-3") ? "low" : "none";
  }
  if (thinkingMode === "low") {
    return "low";
  }
  if (thinkingMode === "provider_default") {
    return null;
  }
  if (normalized.includes("gemini-2.5")) {
    return "none";
  }
  if (normalized.includes("gemini-3")) {
    return "low";
  }
  return null;
}

export function extractProviderErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record.status === "number" ? `status=${record.status} ` : "";
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    return `${status}${message}`.trim();
  }
  return String(error);
}

export function isProviderAbortError(error: unknown): boolean {
  const text = extractProviderErrorMessage(error).toLowerCase();
  return text.includes("abort") || text.includes("cancel");
}
