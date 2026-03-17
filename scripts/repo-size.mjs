import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const excludes = ["demo"];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--exclude") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value after --exclude");
      }
      excludes.push(value);
      index += 1;
    }
  }
  return {
    excludes: excludes
      .map((value) => value.replace(/[\\/]+$/u, "").replace(/^[\\/]+/u, ""))
      .filter(Boolean)
  };
}

function formatBytes(bytes) {
  return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`;
}

function isExcluded(relativePath, excludes) {
  const normalized = relativePath.split(path.sep).join("/");
  return excludes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function listGitFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" }
  );
  return output.split("\0").filter(Boolean);
}

function main() {
  const { excludes } = parseArgs(process.argv.slice(2));
  const files = listGitFiles();

  let count = 0;
  let totalSize = 0;

  for (const relativePath of files) {
    if (isExcluded(relativePath, excludes)) {
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(relativePath);
    } catch {
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    count += 1;
    totalSize += stat.size;
  }

  console.log(`Files counted: ${count}`);
  console.log(`Excluded prefixes: ${excludes.length > 0 ? excludes.join(", ") : "(none)"}`);
  console.log(`Total size: ${formatBytes(totalSize)}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
