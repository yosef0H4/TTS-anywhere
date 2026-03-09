// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    const versionFile = path.join(root, "runtime", ".bundled-services-version");

    fs.mkdirSync(sourceRoot, { recursive: true });

    const result = syncBundledServicesToRuntime({
      appVersion: "1.2.3",
      isPackaged: false,
      sourceRoot,
      targetRoot,
      versionFile
    });

    expect(result).toBe(sourceRoot);
    expect(fs.existsSync(targetRoot)).toBe(false);
  });

  it("keeps the existing runtime tree when the version matches", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const versionFile = path.join(root, "runtime", ".bundled-services-version");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "keep");
    writeFile(versionFile, "1.2.3");

    syncBundledServicesToRuntime({
      appVersion: "1.2.3",
      isPackaged: true,
      sourceRoot,
      targetRoot,
      versionFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(false);
  });

  it("recreates the runtime tree when the version changes", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const versionFile = path.join(root, "runtime", ".bundled-services-version");

    writeFile(path.join(sourceRoot, "tts", "edge", "fresh.txt"), "fresh");
    writeFile(path.join(sourceRoot, "tts", "edge", ".venv", "ignored.txt"), "ignored");
    writeFile(path.join(targetRoot, "tts", "edge", "stale.txt"), "stale");
    writeFile(path.join(targetRoot, "tts", "edge", ".venv", "old.txt"), "old");
    writeFile(versionFile, "1.2.2");

    syncBundledServicesToRuntime({
      appVersion: "1.2.3",
      isPackaged: true,
      sourceRoot,
      targetRoot,
      versionFile
    });

    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(targetRoot, "tts", "edge", ".venv"))).toBe(false);
    expect(fs.readFileSync(versionFile, "utf-8")).toBe("1.2.3");
  });

  it("rebuilds when the target tree is missing even if the version file matches", () => {
    const root = makeTempDir();
    const sourceRoot = path.join(root, "services");
    const targetRoot = path.join(root, "runtime", "services");
    const versionFile = path.join(root, "runtime", ".bundled-services-version");

    writeFile(path.join(sourceRoot, "text_processing", "rapid", "launcher.py"), "print('ok')");
    writeFile(versionFile, "1.2.3");

    syncBundledServicesToRuntime({
      appVersion: "1.2.3",
      isPackaged: true,
      sourceRoot,
      targetRoot,
      versionFile
    });

    expect(fs.existsSync(path.join(targetRoot, "text_processing", "rapid", "launcher.py"))).toBe(true);
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
