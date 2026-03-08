import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import AdmZip from "adm-zip";

const UV_VERSION = "0.10.9";
const UV_WINDOWS_ZIP_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;

const projectRoot = process.cwd();
const binDir = path.join(projectRoot, "bin");
const targetExe = path.join(binDir, "uv.exe");
const targetUvxExe = path.join(binDir, "uvx.exe");
const force = process.argv.includes("--force");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  if (!force && await fileExists(targetExe)) {
    console.log(`[uv] already present at ${targetExe}`);
    return;
  }

  await fs.mkdir(binDir, { recursive: true });
  console.log(`[uv] downloading ${UV_WINDOWS_ZIP_URL}`);
  const zipBuffer = await downloadBuffer(UV_WINDOWS_ZIP_URL);
  const zip = new AdmZip(zipBuffer);

  const uvEntry = zip.getEntry("uv.exe");
  if (!uvEntry) {
    throw new Error("Downloaded archive does not contain uv.exe");
  }
  await fs.writeFile(targetExe, uvEntry.getData());

  const uvxEntry = zip.getEntry("uvx.exe");
  if (uvxEntry) {
    await fs.writeFile(targetUvxExe, uvxEntry.getData());
  }

  console.log(`[uv] installed ${path.relative(projectRoot, targetExe)} from uv ${UV_VERSION}`);
}

await main();
