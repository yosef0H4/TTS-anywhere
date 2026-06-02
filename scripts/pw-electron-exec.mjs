#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 30000;
const DEV_PAGE_HINTS = ["localhost:5173", "127.0.0.1:5173"];

function usage() {
  return [
    "Usage:",
    "  npm run pw:exec -- \"return await page.title()\"",
    "  npm run pw:exec -- --file scripts/debug-snippet.mjs",
    "  npm run pw:exec -- --stdin",
    "",
    "Options:",
    "  --endpoint <url>  CDP endpoint. Default: http://127.0.0.1:9222",
    "  --page <pattern>  Page URL substring or /regex/flags selector.",
    "  --timeout <ms>   Connection timeout. Default: 30000",
    "  --file <path>    Read snippet from a file.",
    "  --stdin          Read snippet from stdin.",
    "  --self-test      Validate CLI argument parsing without Electron."
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    endpoint: DEFAULT_ENDPOINT,
    pagePattern: null,
    timeout: DEFAULT_TIMEOUT_MS,
    file: null,
    stdin: false,
    selfTest: false,
    snippetParts: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.snippetParts.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (arg === "--stdin") {
      options.stdin = true;
      continue;
    }
    if (arg === "--endpoint" || arg === "--page" || arg === "--timeout" || arg === "--file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value after ${arg}`);
      }
      if (arg === "--endpoint") options.endpoint = value;
      if (arg === "--page") options.pagePattern = value;
      if (arg === "--file") options.file = value;
      if (arg === "--timeout") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("--timeout must be a positive number of milliseconds");
        }
        options.timeout = parsed;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options.snippetParts.push(arg);
  }

  const sourceCount = Number(Boolean(options.file)) + Number(options.stdin) + Number(options.snippetParts.length > 0);
  if (!options.help && !options.selfTest && sourceCount !== 1) {
    throw new Error("Provide exactly one snippet source: positional code, --file, or --stdin");
  }

  return options;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readSnippet(options) {
  if (options.file) {
    return fs.readFileSync(path.resolve(options.file), "utf8");
  }
  if (options.stdin) {
    return readStdin();
  }
  return options.snippetParts.join(" ");
}

function patternMatches(pattern, value) {
  if (!pattern) return false;
  const regexMatch = pattern.match(/^\/(.*)\/([a-z]*)$/iu);
  if (regexMatch) {
    return new RegExp(regexMatch[1], regexMatch[2]).test(value);
  }
  return value.includes(pattern);
}

function selectPage(contexts, pagePattern) {
  const pages = contexts.flatMap((context) => context.pages());
  if (pages.length === 0) {
    throw new Error("No pages are available from the CDP endpoint.");
  }

  if (pagePattern) {
    const matched = pages.find((page) => patternMatches(pagePattern, page.url()));
    if (matched) return matched;
    throw new Error(`No page matched ${pagePattern}.\nDiscovered pages:\n${formatPageList(pages)}`);
  }

  return (
    pages.find((page) => DEV_PAGE_HINTS.some((hint) => page.url().includes(hint))) ??
    pages.find((page) => !page.url().startsWith("devtools://")) ??
    pages[0]
  );
}

function formatPageList(pages) {
  return pages.map((page, index) => `  ${index + 1}. ${page.url() || "(blank)"}`).join("\n");
}

function formatResult(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function executeSnippet({ browser, page, source }) {
  const context = page.context();
  const runner = new Function(
    "page",
    "context",
    "browser",
    "expect",
    "fs",
    "path",
    `"use strict"; return (async () => {\n${source}\n})();`
  );
  return runner(page, context, browser, expect, fs, path);
}

async function run(options) {
  const source = await readSnippet(options);
  let browser;

  try {
    browser = await chromium.connectOverCDP(options.endpoint, {
      timeout: options.timeout,
      isLocal: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to Electron CDP endpoint ${options.endpoint}.\n` +
      "Start the debug dev app first with: npm run dev:electron:debug\n" +
      message
    );
  }

  try {
    const page = selectPage(browser.contexts(), options.pagePattern);
    const result = await executeSnippet({ browser, page, source });
    const output = formatResult(result);
    if (output) {
      console.log(output);
    }
  } finally {
    await browser.close();
  }
}

function runSelfTest() {
  const parsed = parseArgs([
    "--endpoint",
    "http://127.0.0.1:9333",
    "--page",
    "localhost:5173",
    "--timeout",
    "1234",
    "return await page.title()"
  ]);
  if (parsed.endpoint !== "http://127.0.0.1:9333") throw new Error("endpoint parse failed");
  if (parsed.pagePattern !== "localhost:5173") throw new Error("page parse failed");
  if (parsed.timeout !== 1234) throw new Error("timeout parse failed");
  if (parsed.snippetParts.join(" ") !== "return await page.title()") throw new Error("snippet parse failed");
  if (!patternMatches("/localhost:5173/u", "http://localhost:5173/")) throw new Error("regex page match failed");
  if (formatResult({ ok: true }) !== "{\n  \"ok\": true\n}") throw new Error("JSON formatting failed");
  const terminatorParsed = parseArgs(["--", "return await page.title()"]);
  if (terminatorParsed.snippetParts.join(" ") !== "return await page.title()") throw new Error("terminator parse failed");
  console.log("pw-electron-exec self-test passed");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  await run(options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
