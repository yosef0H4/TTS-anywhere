import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ignore from "ignore";

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, ".bundle-resources");
const servicesOutputRoot = path.join(outputRoot, "services");
const binOutputRoot = path.join(outputRoot, "bin");
const requireUv = process.argv.includes("--require-uv");

const serviceRoots = [
  "services/text_processing/rapid",
  "services/text_processing/paddle",
  "services/text_processing/h2ovl",
  "services/tts/edge",
  "services/tts/kokoro",
  "services/tts/kitten",
  "services/tts/piper"
];

const allowedTopLevelFiles = new Set([
  "README.md",
  "pyproject.toml",
  "uv.lock",
  "launcher.py",
  ".python-version"
]);

const allowedTopLevelDirs = new Set(["src", "scripts"]);

const bannedPathParts = [
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
  "bench_data",
  "bench_results"
];

async function readIgnoreFile(relativePath) {
  try {
    return await fs.readFile(path.join(projectRoot, relativePath), "utf8");
  } catch {
    return "";
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildIgnoreMatcher(serviceRoot) {
  const matcher = ignore();
  const rootIgnore = await readIgnoreFile(".gitignore");
  if (rootIgnore) matcher.add(rootIgnore);
  const serviceIgnore = await readIgnoreFile(path.join(serviceRoot, ".gitignore"));
  if (serviceIgnore) matcher.add(serviceIgnore);
  matcher.add([
    "**/__pycache__",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/*.pyo",
    "**/.venv",
    "**/.venv/**",
    "**/.venv-cpu",
    "**/.venv-cpu/**",
    "**/.venv-gpu",
    "**/.venv-gpu/**",
    "**/.hf-cache",
    "**/.hf-cache/**",
    "**/.paddlex-cache",
    "**/.paddlex-cache/**"
  ]);
  return matcher;
}

function hasBannedPathPart(relativePath) {
  const normalizedParts = relativePath.split(/[\\/]/g);
  return normalizedParts.some((part) => bannedPathParts.includes(part));
}

async function listFiles(root, shouldIgnore) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (relativePath && (hasBannedPathPart(relativePath) || shouldIgnore(relativePath))) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results;
}

function isAllowedServiceRelativePath(relativePath) {
  const parts = relativePath.split(path.sep);
  const topLevel = parts[0];
  if (allowedTopLevelFiles.has(topLevel)) return true;
  if (allowedTopLevelDirs.has(topLevel)) return true;
  return false;
}

function assertNotBanned(relativePath) {
  if (hasBannedPathPart(relativePath)) {
    throw new Error(`Refusing to bundle banned artifact: ${relativePath}`);
  }
  if (relativePath.endsWith(".pyc")) {
    throw new Error(`Refusing to bundle Python cache file: ${relativePath}`);
  }
}

async function copyService(serviceRoot) {
  const matcher = await buildIgnoreMatcher(serviceRoot);
  const sourceRoot = path.join(projectRoot, serviceRoot);
  const files = await listFiles(sourceRoot, (relativePath) => matcher.ignores(relativePath.split(path.sep).join("/")));
  for (const sourcePath of files) {
    const relativeToService = path.relative(sourceRoot, sourcePath);
    if (!isAllowedServiceRelativePath(relativeToService)) {
      continue;
    }
    const relativeToRepo = path.relative(projectRoot, sourcePath).split(path.sep).join("/");
    if (matcher.ignores(relativeToRepo) || matcher.ignores(relativeToService.split(path.sep).join("/"))) {
      continue;
    }
    assertNotBanned(relativeToRepo);
    const targetPath = path.join(outputRoot, relativeToRepo);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function copyBundledUv() {
  const candidates = [
    path.join(projectRoot, "bin", "uv.exe"),
    path.join(projectRoot, "bin", "uv")
  ];
  let source = null;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      source = candidate;
      break;
    }
  }
  if (!source) {
    if (requireUv) {
      throw new Error(`Bundled uv executable is missing. Looked for: ${candidates.join(", ")}`);
    }
    console.warn(`[bundle] skipping missing bundled uv: ${candidates.join(", ")}`);
    return;
  }
  await fs.mkdir(binOutputRoot, { recursive: true });
  await fs.copyFile(source, path.join(binOutputRoot, path.basename(source)));
}

async function main() {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(servicesOutputRoot, { recursive: true });
  for (const serviceRoot of serviceRoots) {
    await copyService(serviceRoot);
  }
  await copyBundledUv();
  console.log(`[bundle] staged services into ${servicesOutputRoot}`);
}

await main();
