// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BundledServicesManifest } from "../electron/service-bundle-manifest";
import { syncBundledServicesToRuntime } from "../electron/runtime-services";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-anywhere-runtime-services-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

function makeManifest(hash: string, services: BundledServicesManifest["services"] = []): BundledServicesManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-03-10T00:00:00.000Z",
    hash,
    services
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncBundledServicesToRuntime", () => {
  it("returns the source root when not packaged", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    fs.mkdirSync(sourceRoot, { recursive: true });

    const result = syncBundledServicesToRuntime({
      isPackaged: false,
      sourceRoot,
      targetRoot,
      bundledManifest: makeManifest("hash-a"),
      manifestFile
    });

    expect(result).toBe(sourceRoot);
    expect(fs.existsSync(targetRoot)).toBe(false);
  });

  it("keeps the existing runtime tree when the bundle hash matches", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "keep");
    writeFile(manifestFile, `${JSON.stringify(makeManifest("hash-a"))}\n`);

    syncBundledServicesToRuntime({
      isPackaged: true,
      sourceRoot,
      targetRoot,
      bundledManifest: makeManifest("hash-a"),
      manifestFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(false);
  });

  it("recreates the runtime tree when the bundle hash changes", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(sourceRoot, "tts", "edge", ".venv", "ignored.txt"), "ignored");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "stale");
    writeFile(path.join(targetRoot, "tts", "edge", ".venv", "old.txt"), "old");
    writeFile(manifestFile, `${JSON.stringify(makeManifest("hash-old"))}\n`);

    syncBundledServicesToRuntime({
      isPackaged: true,
      sourceRoot,
      targetRoot,
      bundledManifest: makeManifest("hash-new"),
      manifestFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", ".venv"))).toBe(false);
    const writtenManifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as BundledServicesManifest;
    expect(writtenManifest.hash).toBe("hash-new");
  });

  it("rebuilds when the target tree is missing even if the bundle hash matches", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    writeFile(path.join(sourceRoot, "text_processing", "rapid", "launcher.py"), "print('ok')");
    writeFile(manifestFile, `${JSON.stringify(makeManifest("hash-a"))}\n`);

    syncBundledServicesToRuntime({
      isPackaged: true,
      sourceRoot,
      targetRoot,
      bundledManifest: makeManifest("hash-a"),
      manifestFile
    });

    expect(fs.existsSync(path.join(targetRoot, "text_processing", "rapid", "launcher.py"))).toBe(true);
  });

  it("rebuilds when the runtime manifest is missing", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "stale");

    syncBundledServicesToRuntime({
      isPackaged: true,
      sourceRoot,
      targetRoot,
      bundledManifest: makeManifest("hash-a"),
      manifestFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(false);
  });

  it("rebuilds when the bundled manifest is missing", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const manifestFile = path.join(root, "runtime", ".bundled-services-manifest.json");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "stale");
    writeFile(manifestFile, `${JSON.stringify(makeManifest("hash-old"))}\n`);

    syncBundledServicesToRuntime({
      isPackaged: true,
      sourceRoot,
      targetRoot,
      bundledManifest: null,
      manifestFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(false);
    expect(fs.existsSync(manifestFile)).toBe(false);
  });
});

describe("prepare bundled resources manifest", () => {
  it("exports a stable manifest hash from staged services", async () => {
    const root = makeTempDir();
    const servicesRoot = path.join(root, "services");
    writeFile(path.join(servicesRoot, "tts", "edge", "launcher.py"), "print('one')");
    writeFile(path.join(servicesRoot, "tts", "edge", "scripts", "host.bat"), "@echo off\r\n");

    const scriptPath = path.resolve(process.cwd(), "scripts/prepare-bundled-resources.mjs");
    const { createBundleManifest } = await import(scriptPath);
    const manifestA = await createBundleManifest(servicesRoot);
    const manifestB = await createBundleManifest(servicesRoot);

    expect(manifestA.hash).toBe(manifestB.hash);
    expect(manifestA.services.map((entry: { path: string }) => entry.path)).toEqual([
      "tts/edge/launcher.py",
      "tts/edge/scripts/host.bat"
    ]);
  });
});

describe("windows packaging config", () => {
  it("wires the NSIS uninstall include", async () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf-8")) as {
      build?: { nsis?: { include?: string } };
    };

    expect(packageJson.build?.nsis?.include).toBe("build/installer.nsh");
  });
});
