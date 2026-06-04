import fs from "node:fs";
import path from "node:path";

export const STACK_SERVICE_MANIFEST = "stack.service.json";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  ".venv-cpu",
  ".venv-gpu",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".hf-cache",
  ".paddlex-cache",
  "node_modules",
  "dist",
  "dist-electron",
  "build"
]);

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type ServiceSource = "bundled" | "external";
export type ServiceFamily = "ocr" | "tts";
export type ServiceCapability = "detect" | "ocr" | "speech";
export type ServiceConfigTarget = "textProcessing.detectorBaseUrl" | "tts.baseUrl";
export type ServiceDevice = "cpu" | "gpu";

export interface ServiceLauncher {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServiceRuntimeMode {
  detect?: ServiceDevice;
  ocr?: ServiceDevice;
  speech?: ServiceDevice;
}

export interface ServicePreset {
  id: string;
  name: string;
  defaultPort: number;
  args?: string[];
  env?: Record<string, string>;
  capabilities: ServiceCapability[];
  configTargets: ServiceConfigTarget[];
  runtime?: ServiceRuntimeMode;
}

export interface ServiceSelector {
  id: string;
  name: string;
  capabilities: ServiceCapability[];
  presetId?: string;
  runtime?: ServiceRuntimeMode;
}

export interface ServiceManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  family: ServiceFamily;
  description?: string;
  healthPath?: string;
  launcher: ServiceLauncher;
  presets: ServicePreset[];
  selectors?: ServiceSelector[];
}

export interface ServiceScanRoot {
  path: string;
  source: ServiceSource;
}

export interface ServiceManifestError {
  manifestPath: string;
  message: string;
}

export interface DiscoveredService {
  manifest: ServiceManifest;
  manifestPath: string;
  servicePath: string;
  rootPath: string;
  relativePath: string;
  source: ServiceSource;
}

export interface ServiceScanResult {
  services: DiscoveredService[];
  errors: ServiceManifestError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEnvMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isServiceCapability(value: unknown): value is ServiceCapability {
  return value === "detect" || value === "ocr" || value === "speech";
}

function isServiceConfigTarget(value: unknown): value is ServiceConfigTarget {
  return value === "textProcessing.detectorBaseUrl" || value === "tts.baseUrl";
}

function isServiceDevice(value: unknown): value is ServiceDevice {
  return value === "cpu" || value === "gpu";
}

function isRuntimeMode(value: unknown): value is ServiceRuntimeMode {
  if (!isRecord(value)) return false;
  if (value.detect !== undefined && !isServiceDevice(value.detect)) return false;
  if (value.ocr !== undefined && !isServiceDevice(value.ocr)) return false;
  if (value.speech !== undefined && !isServiceDevice(value.speech)) return false;
  return true;
}

function normalizeHealthPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateLauncher(value: unknown): ServiceLauncher | null {
  if (!isRecord(value)) return null;
  if (typeof value.executable !== "string" || value.executable.trim().length === 0) return null;
  if (value.args !== undefined && !isStringArray(value.args)) return null;
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.trim().length === 0)) return null;
  if (value.env !== undefined && !isEnvMap(value.env)) return null;
  const launcher: ServiceLauncher = {
    executable: value.executable.trim(),
  };
  if (value.args !== undefined) launcher.args = value.args;
  if (typeof value.cwd === "string") launcher.cwd = value.cwd.trim();
  if (value.env !== undefined) launcher.env = value.env;
  return launcher;
}

function validateIdName(value: Record<string, unknown>, seenIds: Set<string>): { id: string; name: string } | null {
  if (typeof value.id !== "string" || !SERVICE_ID_PATTERN.test(value.id)) return null;
  if (seenIds.has(value.id)) return null;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return null;
  seenIds.add(value.id);
  return { id: value.id, name: value.name.trim() };
}

function validateCapabilities(value: unknown): ServiceCapability[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isServiceCapability)) return null;
  return [...value];
}

function validatePreset(value: unknown, seenIds: Set<string>): ServicePreset | null {
  if (!isRecord(value)) return null;
  const idName = validateIdName(value, seenIds);
  if (idName === null) return null;
  if (typeof value.defaultPort !== "number" || !Number.isInteger(value.defaultPort) || value.defaultPort < 1 || value.defaultPort > 65535) {
    return null;
  }
  if (value.args !== undefined && !isStringArray(value.args)) return null;
  if (value.env !== undefined && !isEnvMap(value.env)) return null;
  const capabilities = validateCapabilities(value.capabilities);
  if (capabilities === null) return null;
  if (!Array.isArray(value.configTargets) || value.configTargets.length === 0 || !value.configTargets.every(isServiceConfigTarget)) {
    return null;
  }
  if (value.runtime !== undefined && !isRuntimeMode(value.runtime)) return null;

  const preset: ServicePreset = {
    id: idName.id,
    name: idName.name,
    defaultPort: value.defaultPort,
    capabilities,
    configTargets: [...value.configTargets]
  };
  if (value.args !== undefined) preset.args = value.args;
  if (value.env !== undefined) preset.env = value.env;
  if (value.runtime !== undefined) preset.runtime = value.runtime;
  return preset;
}

function validateSelector(value: unknown, presetIds: Set<string>, seenIds: Set<string>): ServiceSelector | null {
  if (!isRecord(value)) return null;
  const idName = validateIdName(value, seenIds);
  if (idName === null) return null;
  const capabilities = validateCapabilities(value.capabilities);
  if (capabilities === null) return null;
  const presetId = typeof value.presetId === "string" ? value.presetId : undefined;
  if (presetId !== undefined && !presetIds.has(presetId)) return null;
  const runtime = value.runtime !== undefined
    ? (isRuntimeMode(value.runtime) ? value.runtime : null)
    : undefined;
  if (runtime === null) return null;
  if (presetId === undefined && runtime === undefined) return null;
  return {
    id: idName.id,
    name: idName.name,
    capabilities,
    ...(presetId ? { presetId } : {}),
    ...(runtime ? { runtime } : {})
  };
}

export function parseServiceManifest(raw: string): ServiceManifest | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.id !== "string" || !SERVICE_ID_PATTERN.test(parsed.id)) return null;
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) return null;
    if (parsed.family !== "ocr" && parsed.family !== "tts") return null;
    if (parsed.description !== undefined && typeof parsed.description !== "string") return null;
    const launcher = validateLauncher(parsed.launcher);
    if (launcher === null) return null;
    if (!Array.isArray(parsed.presets) || parsed.presets.length === 0) return null;

    const seenIds = new Set<string>();
    const presets: ServicePreset[] = [];
    for (const preset of parsed.presets) {
      const validated = validatePreset(preset, seenIds);
      if (validated === null) return null;
      presets.push(validated);
    }
    const presetIds = new Set(presets.map((preset) => preset.id));
    const selectors: ServiceSelector[] = [];
    if (parsed.selectors !== undefined) {
      if (!Array.isArray(parsed.selectors) || parsed.selectors.length === 0) return null;
      const seenSelectorIds = new Set<string>();
      for (const selector of parsed.selectors) {
        const validated = validateSelector(selector, presetIds, seenSelectorIds);
        if (validated === null) return null;
        selectors.push(validated);
      }
    }

    const manifest: ServiceManifest = {
      schemaVersion: 1,
      id: parsed.id,
      name: parsed.name.trim(),
      family: parsed.family,
      healthPath: normalizeHealthPath(parsed.healthPath) ?? "/healthz",
      launcher,
      presets
    };
    if (typeof parsed.description === "string") {
      manifest.description = parsed.description.trim();
    }
    if (selectors.length > 0) {
      manifest.selectors = selectors;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function readServiceManifest(manifestPath: string): ServiceManifest | null {
  try {
    return parseServiceManifest(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function collectManifestFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return [];

  const pending = [rootPath];
  const manifestPaths: string[] = [];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) continue;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        pending.push(path.join(currentPath, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name !== STACK_SERVICE_MANIFEST) continue;
      manifestPaths.push(path.join(currentPath, entry.name));
    }
  }
  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

export function scanServiceManifests(roots: ServiceScanRoot[]): ServiceScanResult {
  const services: DiscoveredService[] = [];
  const errors: ServiceManifestError[] = [];

  for (const root of roots) {
    for (const manifestPath of collectManifestFiles(root.path)) {
      const manifest = readServiceManifest(manifestPath);
      if (manifest === null) {
        errors.push({ manifestPath, message: "Invalid service manifest" });
        continue;
      }
      const servicePath = path.dirname(manifestPath);
      services.push({
        manifest,
        manifestPath,
        servicePath,
        rootPath: root.path,
        relativePath: path.relative(root.path, servicePath).split(path.sep).join("/"),
        source: root.source
      });
    }
  }

  services.sort((left, right) => {
    const sourceOrder = left.source.localeCompare(right.source);
    if (sourceOrder !== 0) return sourceOrder;
    const idOrder = left.manifest.id.localeCompare(right.manifest.id);
    if (idOrder !== 0) return idOrder;
    return left.relativePath.localeCompare(right.relativePath);
  });

  return { services, errors };
}
