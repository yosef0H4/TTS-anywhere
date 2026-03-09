import fs from "node:fs";
import path from "node:path";

export interface RuntimeServicesSyncOptions {
  appVersion: string;
  isPackaged: boolean;
  sourceRoot: string;
  targetRoot: string;
  versionFile: string;
  logSync?: (context: { version: string; sourceRoot: string; targetRoot: string }) => void;
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

function readRuntimeServicesVersion(versionFile: string): string | null {
  try {
    return fs.readFileSync(versionFile, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function writeRuntimeServicesVersion(versionFile: string, version: string): void {
  ensureDir(path.dirname(versionFile));
  fs.writeFileSync(versionFile, version, "utf-8");
}

function resetRuntimeServicesRoot(targetRoot: string): void {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  ensureDir(targetRoot);
}

export function syncBundledServicesToRuntime(options: RuntimeServicesSyncOptions): string {
  if (!options.isPackaged) {
    return options.sourceRoot;
  }

  const currentVersion = options.appVersion;
  const existingVersion = readRuntimeServicesVersion(options.versionFile);
  if (existingVersion === currentVersion && fs.existsSync(options.targetRoot)) {
    return options.targetRoot;
  }

  resetRuntimeServicesRoot(options.targetRoot);
  const topLevelEntries = fs.readdirSync(options.sourceRoot, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!entry.isDirectory() || runtimeCopyShouldSkipName(entry.name)) continue;
    copyBundledServiceTree(path.join(options.sourceRoot, entry.name), path.join(options.targetRoot, entry.name));
  }
  writeRuntimeServicesVersion(options.versionFile, currentVersion);
  options.logSync?.({
    version: currentVersion,
    sourceRoot: options.sourceRoot,
    targetRoot: options.targetRoot
  });
  return options.targetRoot;
}
