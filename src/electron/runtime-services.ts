import fs from "node:fs";
import path from "node:path";

import type { BundledServicesManifest } from "./service-bundle-manifest.js";

export interface RuntimeServicesSyncOptions {
  isPackaged: boolean;
  sourceRoot: string;
  targetRoot: string;
  bundledManifest: BundledServicesManifest | null;
  manifestFile: string;
  logSync?: (context: {
    action: "skipped" | "synced";
    reason: string;
    sourceRoot: string;
    targetRoot: string;
    bundledHash: string | null;
    runtimeHash: string | null;
  }) => void;
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".venv",
  ".venv-cpu",
  ".venv-gpu",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".hf-cache",
  ".paddlex-cache"
]);

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runtimeCopyShouldSkipName(name: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(name);
}

function runtimeCopyShouldSkipFile(name: string): boolean {
  return name.endsWith(".pyc") || name.endsWith(".pyo");
}

function copyBundledServiceTree(sourceDir: string, targetDir: string): void {
  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (runtimeCopyShouldSkipName(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyBundledServiceTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || runtimeCopyShouldSkipFile(entry.name)) continue;
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function readRuntimeServicesManifest(manifestFile: string): BundledServicesManifest | null {
  try {
    const raw = fs.readFileSync(manifestFile, "utf-8");
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
        (entry): entry is BundledServicesManifest["services"][number] =>
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

function writeRuntimeServicesManifest(manifestFile: string, manifest: BundledServicesManifest): void {
  ensureDir(path.dirname(manifestFile));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function resetRuntimeServicesRoot(targetRoot: string): void {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  ensureDir(targetRoot);
}

export function syncBundledServicesToRuntime(options: RuntimeServicesSyncOptions): string {
  if (!options.isPackaged) {
    return options.sourceRoot;
  }

  const bundledHash = options.bundledManifest?.hash ?? null;
  const runtimeManifest = readRuntimeServicesManifest(options.manifestFile);
  const runtimeHash = runtimeManifest?.hash ?? null;
  const hasTargetRoot = fs.existsSync(options.targetRoot);

  if (bundledHash !== null && runtimeHash === bundledHash && hasTargetRoot) {
    options.logSync?.({
      action: "skipped",
      reason: "bundle hash matched existing runtime services",
      sourceRoot: options.sourceRoot,
      targetRoot: options.targetRoot,
      bundledHash,
      runtimeHash
    });
    return options.targetRoot;
  }

  resetRuntimeServicesRoot(options.targetRoot);
  const topLevelEntries = fs.readdirSync(options.sourceRoot, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!entry.isDirectory() || runtimeCopyShouldSkipName(entry.name)) continue;
    copyBundledServiceTree(path.join(options.sourceRoot, entry.name), path.join(options.targetRoot, entry.name));
  }

  if (options.bundledManifest) {
    writeRuntimeServicesManifest(options.manifestFile, options.bundledManifest);
  } else {
    fs.rmSync(options.manifestFile, { force: true });
  }

  options.logSync?.({
    action: "synced",
    reason:
      bundledHash === null
        ? "bundled services manifest missing or invalid"
        : runtimeHash === null
          ? hasTargetRoot
            ? "runtime services manifest missing or invalid"
            : "runtime services directory missing"
          : !hasTargetRoot
            ? "runtime services directory missing"
            : "bundle hash changed",
    sourceRoot: options.sourceRoot,
    targetRoot: options.targetRoot,
    bundledHash,
    runtimeHash
  });
  return options.targetRoot;
}
