import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["fallow", "dupes", "--format", "json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: process.platform === "win32"
});

if (result.status !== 0 && !result.stdout.trim()) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const duplicatedLines = report.stats?.duplicated_lines ?? 0;
const duplicationPercentage = report.stats?.duplication_percentage ?? 0;
const cloneGroups = report.stats?.clone_groups ?? 0;

if (duplicatedLines > 0 || cloneGroups > 0) {
  console.error(`Fallow duplication check failed: ${duplicatedLines} duplicated lines across ${cloneGroups} clone groups (${duplicationPercentage.toFixed(2)}%).`);
  for (const family of report.clone_families ?? []) {
    console.error(`- ${family.files.join(" | ")}`);
  }
  process.exit(1);
}

console.log("Fallow duplication check passed: 0 duplicated lines.");
