import fs from "node:fs";

export interface BundledServiceFileEntry {
  path: string;
  sha256: string;
}

export interface BundledServicesManifest {
  schemaVersion: 1;
  generatedAt: string;
  hash: string;
  services: BundledServiceFileEntry[];
}

export function readBundledServicesManifest(manifestPath: string): BundledServicesManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BundledServicesManifest>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.generatedAt !== "string") return null;
    if (typeof parsed.hash !== "string" || parsed.hash.length === 0) return null;
    if (!Array.isArray(parsed.services)) return null;
    return {
      schemaVersion: 1,
      generatedAt: parsed.generatedAt,
      hash: parsed.hash,
      services: parsed.services.filter(
        (entry): entry is BundledServiceFileEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.path === "string" &&
          typeof entry.sha256 === "string"
      )
    };
  } catch {
    return null;
  }
}
