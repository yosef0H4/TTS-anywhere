// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseServiceManifest, scanServiceManifests, STACK_SERVICE_MANIFEST } from "../electron/service-manifest";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-anywhere-service-manifest-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

function writeManifest(serviceDir: string, manifest: Record<string, unknown>): void {
  writeFile(path.join(serviceDir, STACK_SERVICE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseServiceManifest", () => {
  it("accepts a manifest with multiple presets", () => {
    const manifest = parseServiceManifest(JSON.stringify({
      schemaVersion: 1,
      id: "paddle",
      name: "Paddle OCR",
      family: "ocr",
      launcher: {
        executable: "python",
        args: ["launcher.py"]
      },
      presets: [
        {
          id: "cpu-detect-ocr",
          name: "CPU Detect + OCR",
          defaultPort: 8093,
          capabilities: ["detect", "ocr"],
          configTargets: ["textProcessing.detectorBaseUrl"],
          runtime: {
            detect: "cpu",
            ocr: "cpu"
          }
        },
        {
          id: "gpu-ocr",
          name: "GPU OCR",
          defaultPort: 8094,
          capabilities: ["ocr"],
          configTargets: ["textProcessing.detectorBaseUrl"],
          args: ["--enable-openai-ocr", "--ocr-device", "gpu"],
          runtime: {
            ocr: "gpu"
          }
        }
      ],
      selectors: [
        {
          id: "paddle",
          name: "Paddle",
          capabilities: ["detect", "ocr"],
          runtime: {
            detect: "cpu",
            ocr: "cpu"
          }
        },
        {
          id: "paddle-nvidia",
          name: "Paddle NVIDIA",
          presetId: "gpu-ocr",
          capabilities: ["ocr"]
        }
      ]
    }));

    expect(manifest).not.toBeNull();
    expect(manifest?.healthPath).toBe("/healthz");
    expect(manifest?.presets).toHaveLength(2);
    expect(manifest?.presets[1]?.runtime?.ocr).toBe("gpu");
    expect(manifest?.selectors?.map((selector) => selector.name)).toEqual(["Paddle", "Paddle NVIDIA"]);
    expect(manifest?.selectors?.[0]?.runtime?.detect).toBe("cpu");
  });

  it("rejects duplicate preset ids", () => {
    const manifest = parseServiceManifest(JSON.stringify({
      schemaVersion: 1,
      id: "edge",
      name: "Edge",
      family: "tts",
      launcher: {
        executable: "uv",
        args: ["run", "tts-edge", "serve"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8012,
          capabilities: ["speech"],
          configTargets: ["tts.baseUrl"]
        },
        {
          id: "default",
          name: "Duplicate",
          defaultPort: 8013,
          capabilities: ["speech"],
          configTargets: ["tts.baseUrl"]
        }
      ]
    }));

    expect(manifest).toBeNull();
  });

  it("rejects selectors that point to missing presets", () => {
    const manifest = parseServiceManifest(JSON.stringify({
      schemaVersion: 1,
      id: "edge",
      name: "Edge",
      family: "tts",
      launcher: {
        executable: "uv",
        args: ["run", "tts-edge", "serve"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8012,
          capabilities: ["speech"],
          configTargets: ["tts.baseUrl"]
        }
      ],
      selectors: [
        {
          id: "edge",
          name: "Edge",
          presetId: "missing",
          capabilities: ["speech"]
        }
      ]
    }));

    expect(manifest).toBeNull();
  });
});

describe("scanServiceManifests", () => {
  it("discovers manifests across bundled and external roots", () => {
    const root = makeTempDir();
    const bundledRoot = path.join(root, "services");
    const externalRoot = path.join(root, "external-services");

    writeManifest(path.join(bundledRoot, "text_processing", "paddle"), {
      schemaVersion: 1,
      id: "paddle",
      name: "Paddle OCR",
      family: "ocr",
      launcher: {
        executable: "python",
        args: ["launcher.py"]
      },
      presets: [
        {
          id: "cpu",
          name: "CPU",
          defaultPort: 8093,
          capabilities: ["detect", "ocr"],
          configTargets: ["textProcessing.detectorBaseUrl"]
        }
      ]
    });

    writeManifest(path.join(externalRoot, "tts", "my-voice"), {
      schemaVersion: 1,
      id: "my-voice",
      name: "My Voice",
      family: "tts",
      launcher: {
        executable: "uv",
        args: ["run", "tts-my-voice", "serve"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8019,
          capabilities: ["speech"],
          configTargets: ["tts.baseUrl"]
        }
      ]
    });

    const result = scanServiceManifests([
      { path: bundledRoot, source: "bundled" },
      { path: externalRoot, source: "external" }
    ]);

    expect(result.errors).toEqual([]);
    expect(result.services.map((service) => service.manifest.id)).toEqual(["paddle", "my-voice"]);
    expect(result.services[0]?.relativePath).toBe("text_processing/paddle");
    expect(result.services[1]?.relativePath).toBe("tts/my-voice");
  });

  it("reports invalid manifests without aborting the scan", () => {
    const root = makeTempDir();
    const bundledRoot = path.join(root, "services");

    writeManifest(path.join(bundledRoot, "text_processing", "good"), {
      schemaVersion: 1,
      id: "good",
      name: "Good OCR",
      family: "ocr",
      launcher: {
        executable: "python",
        args: ["launcher.py"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8100,
          capabilities: ["detect"],
          configTargets: ["textProcessing.detectorBaseUrl"]
        }
      ]
    });

    writeManifest(path.join(bundledRoot, "text_processing", "broken"), {
      schemaVersion: 1,
      id: "broken",
      name: "Broken OCR",
      family: "ocr",
      launcher: {
        executable: "python"
      },
      presets: []
    });

    const result = scanServiceManifests([{ path: bundledRoot, source: "bundled" }]);

    expect(result.services.map((service) => service.manifest.id)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.manifestPath.endsWith(STACK_SERVICE_MANIFEST)).toBe(true);
  });

  it("reflects folder deletion on the next scan", () => {
    const root = makeTempDir();
    const externalRoot = path.join(root, "external-services");
    const serviceDir = path.join(externalRoot, "tts", "temp-service");

    writeManifest(serviceDir, {
      schemaVersion: 1,
      id: "temp-service",
      name: "Temp Service",
      family: "tts",
      launcher: {
        executable: "uv",
        args: ["run", "temp-service", "serve"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8020,
          capabilities: ["speech"],
          configTargets: ["tts.baseUrl"]
        }
      ]
    });

    expect(scanServiceManifests([{ path: externalRoot, source: "external" }]).services).toHaveLength(1);

    fs.rmSync(serviceDir, { recursive: true, force: true });

    expect(scanServiceManifests([{ path: externalRoot, source: "external" }]).services).toHaveLength(0);
  });

  it("skips manifests inside ignored cache directories", () => {
    const root = makeTempDir();
    const bundledRoot = path.join(root, "services");

    writeManifest(path.join(bundledRoot, "text_processing", "rapid", ".venv", "bad-copy"), {
      schemaVersion: 1,
      id: "ignored-copy",
      name: "Ignored Copy",
      family: "ocr",
      launcher: {
        executable: "python",
        args: ["launcher.py"]
      },
      presets: [
        {
          id: "default",
          name: "Default",
          defaultPort: 8111,
          capabilities: ["detect"],
          configTargets: ["textProcessing.detectorBaseUrl"]
        }
      ]
    });

    const result = scanServiceManifests([{ path: bundledRoot, source: "bundled" }]);
    expect(result.services).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it("parses the current bundled paddle and edge manifests", () => {
    const result = scanServiceManifests([{ path: path.join(workspaceRoot, "services"), source: "bundled" }]);

    expect(result.errors).toEqual([]);
    expect(result.services.some((service) => service.manifest.id === "paddle")).toBe(true);
    expect(result.services.some((service) => service.manifest.id === "edge")).toBe(true);
  });
});