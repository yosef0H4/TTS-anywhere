#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9333";
const DEFAULT_TIMEOUT_MS = 30000;
const DEV_PAGE_HINTS = ["localhost:5173", "127.0.0.1:5173"];
const DEFAULT_LOG_PATH = path.resolve("logs", "tts-anywhere.log");
const AGENT_STATE_PATH = path.resolve(".cache", "electron-agent-dev.json");
const AGENT_ARTIFACT_DIR = path.resolve("test-results", "agent");

function usage() {
  return [
    "Usage:",
    "  npm run pw:exec -- \"return await page.title()\"",
    "  npm run pw:exec -- --file scripts/debug-snippet.mjs",
    "  npm run pw:exec -- --stdin",
    "",
    "Options:",
    "  --endpoint <url>  CDP endpoint. Default: http://127.0.0.1:9333",
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

function resolveDefaultEndpoint() {
  try {
    const state = JSON.parse(fs.readFileSync(AGENT_STATE_PATH, "utf8"));
    if (typeof state.cdpEndpoint === "string" && state.cdpEndpoint) return state.cdpEndpoint;
    if (Number.isFinite(Number(state.cdpPort))) return `http://127.0.0.1:${Number(state.cdpPort)}`;
  } catch {
    // Fall back to the conventional port.
  }
  return DEFAULT_ENDPOINT;
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

function parseLogLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Fall through to raw-line shape.
  }
  return { raw: line };
}

function logMatches(entry, options) {
  if (options.category && entry.category !== options.category) return false;
  if (options.level && entry.level !== options.level) return false;
  if (options.since && typeof entry.timestamp === "string" && entry.timestamp < options.since) return false;
  return true;
}

function createLogsHelper() {
  return {
    tail(options = {}) {
      const lines = Number.isFinite(Number(options.lines)) ? Math.max(1, Math.floor(Number(options.lines))) : 80;
      const logPath = path.resolve(String(options.path ?? DEFAULT_LOG_PATH));
      if (!fs.existsSync(logPath)) {
        return {
          path: logPath,
          entries: [],
          missing: true
        };
      }
      const rawLines = fs.readFileSync(logPath, "utf8").split(/\r?\n/u).filter(Boolean);
      const entries = rawLines
        .map(parseLogLine)
        .filter((entry) => logMatches(entry, options))
        .slice(-lines);
      return {
        path: logPath,
        entries
      };
    }
  };
}

function safeArtifactPath(name) {
  const normalized = String(name || `artifact-${Date.now()}`)
    .replace(/[/\\:]/gu, "-")
    .replace(/[^\w .()-]/gu, "_");
  const resolved = path.resolve(AGENT_ARTIFACT_DIR, normalized);
  if (!resolved.startsWith(AGENT_ARTIFACT_DIR + path.sep) && resolved !== AGENT_ARTIFACT_DIR) {
    throw new Error(`Artifact path escaped ${AGENT_ARTIFACT_DIR}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function listBrowserPages(browser, selectedPage = null) {
  const summaries = [];
  for (const context of browser.contexts()) {
    for (const browserPage of context.pages()) {
      if (browserPage.isClosed()) continue;
      let id = null;
      try {
        const session = await context.newCDPSession(browserPage);
        try {
          const result = await session.send("Target.getTargetInfo");
          id = result?.targetInfo?.targetId ?? null;
        } finally {
          await session.detach().catch(() => undefined);
        }
      } catch {
        // Some internal pages do not expose target info. Keep the page visible in the list.
      }
      let title = "";
      try {
        title = await Promise.race([
          browserPage.title(),
          new Promise((resolve) => setTimeout(() => resolve(""), 1500))
        ]);
      } catch {
        title = "";
      }
      summaries.push({
        id,
        url: browserPage.url(),
        title,
        selected: browserPage === selectedPage
      });
    }
  }
  return summaries;
}

function createDebugHelper(page, browser, logs) {
  async function rootLayoutState(label = "layout") {
    return page.evaluate((nextLabel) => {
      const shell = document.getElementById("app-shell");
      const drawer = document.getElementById("settings-drawer");
      const settings = document.getElementById("settings-layout");
      const shellRect = shell?.getBoundingClientRect();
      const drawerRect = drawer?.getBoundingClientRect();
      return {
        label: nextLabel,
        shellScrollTop: shell?.scrollTop ?? null,
        shellScrollLeft: shell?.scrollLeft ?? null,
        shellTop: shellRect?.top ?? null,
        shellBottom: shellRect?.bottom ?? null,
        drawerTop: drawerRect?.top ?? null,
        drawerBottom: drawerRect?.bottom ?? null,
        settingsScrollTop: settings?.scrollTop ?? null,
        settingsClientHeight: settings?.clientHeight ?? null,
        settingsScrollHeight: settings?.scrollHeight ?? null
      };
    }, String(label));
  }

  async function openSettings() {
    await page.evaluate(() => {
      const drawer = document.getElementById("settings-drawer");
      if (drawer?.getAttribute("aria-hidden") === "false") return;
      const button = document.getElementById("btn-settings-toggle");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing #btn-settings-toggle");
      button.click();
    });
    await expect(page.locator("#settings-drawer")).toHaveAttribute("aria-hidden", "false");
    return rootLayoutState("settings-open");
  }

  async function scrollSettingsTo(selector, options = {}) {
    await openSettings();
    return page.evaluate(({ nextSelector, block }) => {
      const target = document.querySelector(nextSelector);
      const scroller = document.getElementById("settings-layout");
      if (!(target instanceof HTMLElement)) throw new Error(`No settings target matched ${nextSelector}`);
      if (!(scroller instanceof HTMLElement)) throw new Error("Missing #settings-layout");
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const targetTop = targetRect.top - scrollerRect.top + scroller.scrollTop;
      const targetBottom = targetRect.bottom - scrollerRect.top + scroller.scrollTop;
      if (block === "center") {
        scroller.scrollTop = targetTop - (scroller.clientHeight - targetRect.height) / 2;
      } else if (targetTop < scroller.scrollTop) {
        scroller.scrollTop = targetTop;
      } else if (targetBottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = targetBottom - scroller.clientHeight;
      }
      const shell = document.getElementById("app-shell");
      if (shell) {
        shell.scrollTop = 0;
        shell.scrollLeft = 0;
      }
      const rect = target.getBoundingClientRect();
      return {
        selector: nextSelector,
        targetTop: rect.top,
        targetBottom: rect.bottom,
        settingsScrollTop: scroller.scrollTop,
        shellScrollTop: shell?.scrollTop ?? null
      };
    }, { nextSelector: String(selector), block: options.block ?? "nearest" });
  }

  async function clickSettings(selector, options = {}) {
    await scrollSettingsTo(selector, options);
    await page.evaluate((nextSelector) => {
      const target = document.querySelector(nextSelector);
      if (!(target instanceof HTMLElement)) throw new Error(`No settings target matched ${nextSelector}`);
      target.focus({ preventScroll: true });
      target.click();
      const shell = document.getElementById("app-shell");
      if (shell) {
        shell.scrollTop = 0;
        shell.scrollLeft = 0;
      }
    }, String(selector));
    return rootLayoutState(`clicked ${selector}`);
  }

  async function serviceState() {
    return page.evaluate(() => {
      const chipText = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
      const selectedText = (id) => {
        const select = document.getElementById(id);
        const tom = select?.tomselect;
        if (tom) {
          const value = String(tom.getValue?.() ?? "");
          return {
            value,
            text: value ? String(tom.options?.[value]?.text ?? tom.options?.[value]?.label ?? "") : ""
          };
        }
        if (select instanceof HTMLSelectElement) {
          return {
            value: select.value,
            text: select.selectedOptions[0]?.textContent?.trim() ?? ""
          };
        }
        return { value: "", text: "" };
      };
      return {
        chips: {
          detect: chipText("service-detect-status-chip"),
          ocr: chipText("service-ocr-status-chip"),
          tts: chipText("service-tts-status-chip")
        },
        selections: {
          detect: selectedText("service-detect-select"),
          ocr: selectedText("service-ocr-select"),
          tts: selectedText("service-tts-select")
        },
        statusText: document.getElementById("status-text")?.textContent ?? null
      };
    });
  }

  async function selectService(slot, label) {
    return page.evaluate(({ nextSlot, nextLabel }) => {
      const select = document.getElementById(`service-${nextSlot}-select`);
      const tom = select?.tomselect;
      if (!tom) throw new Error(`service-${nextSlot}-select has no TomSelect instance`);
      const match = Object.entries(tom.options).find(([, option]) => {
        return String(option.text ?? option.label ?? "").trim() === nextLabel;
      });
      if (!match) {
        const labels = Object.values(tom.options).map((option) => String(option.text ?? option.label ?? "").trim()).filter(Boolean);
        throw new Error(`No ${nextSlot} service option "${nextLabel}". Options: ${labels.join(", ")}`);
      }
      tom.setValue(match[0]);
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { slot: nextSlot, label: nextLabel, value: match[0] };
    }, { nextSlot: slot, nextLabel: label });
  }

  async function launchSelectedServices() {
    await page.evaluate(() => {
      const button = document.getElementById("btn-launch-selected-services");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing #btn-launch-selected-services");
      button.click();
    });
    return serviceState();
  }

  async function stopSelectedServices() {
    await page.evaluate(() => {
      const button = document.getElementById("btn-stop-selected-services");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing #btn-stop-selected-services");
      button.click();
    });
    return serviceState();
  }

  async function snapshot(options = {}) {
    const maxItems = Number.isFinite(Number(options.maxItems)) ? Math.max(1, Number(options.maxItems)) : 160;
    return page.evaluate(({ nextMaxItems }) => {
      const roleOf = (element) => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const type = element.getAttribute("type") || "text";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          return "textbox";
        }
        if (/^h[1-6]$/u.test(tag)) return "heading";
        return tag;
      };
      const labelOf = (element) => {
        const aria = element.getAttribute("aria-label") || element.getAttribute("title");
        if (aria) return aria.trim();
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\s+/u)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ");
          if (text) return text;
        }
        if (element.id) {
          const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim();
          if (label) return label;
        }
        return (element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 140);
      };
      const valueOf = (element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          return element.value;
        }
        const chip = element.id?.endsWith("-status-chip") ? element.textContent?.trim() : "";
        return chip || "";
      };
      const isVisible = (element) => {
        for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
          if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") return false;
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
      };
      const interesting = "button,a,input,textarea,select,[role],[aria-label],h1,h2,h3,h4,h5,h6,#status-text,[id$='status-chip'],.active-chunk";
      const rows = [];
      for (const element of Array.from(document.querySelectorAll(interesting))) {
        if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
        rows.push({
          role: roleOf(element),
          id: element.id || null,
          text: labelOf(element),
          value: valueOf(element) || null,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          pressed: element.getAttribute("aria-pressed"),
          expanded: element.getAttribute("aria-expanded")
        });
        if (rows.length >= nextMaxItems) break;
      }
      const full = rows.map((row, index) => {
        const bits = [`${index + 1}. ${row.role}`];
        if (row.id) bits.push(`#${row.id}`);
        if (row.text) bits.push(JSON.stringify(row.text));
        if (row.value && row.value !== row.text) bits.push(`value=${JSON.stringify(row.value)}`);
        if (row.disabled) bits.push("disabled");
        if (row.pressed !== null) bits.push(`pressed=${row.pressed}`);
        if (row.expanded !== null) bits.push(`expanded=${row.expanded}`);
        return bits.join(" ");
      }).join("\n");
      return {
        url: location.href,
        title: document.title,
        full,
        items: rows
      };
    }, { nextMaxItems: maxItems });
  }

  return {
    async pages() {
      return listBrowserPages(browser, page);
    },
    async writeFile(name, data) {
      const outputPath = safeArtifactPath(name);
      fs.writeFileSync(outputPath, String(data));
      return outputPath;
    },
    async saveJson(name, data) {
      const fileName = String(name);
      const outputPath = safeArtifactPath(fileName.endsWith(".json") ? fileName : `${fileName}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
      return outputPath;
    },
    async screenshot(options = {}) {
      const screenshotPath = options.path
        ? path.resolve(String(options.path))
        : safeArtifactPath(`electron-debug-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({
        path: screenshotPath,
        fullPage: options.fullPage !== false
      });
      return screenshotPath;
    },
    layout: rootLayoutState,
    settings: {
      open: openSettings,
      scrollTo: scrollSettingsTo,
      click: clickSettings
    },
    async captureText(text, options = {}) {
      return page.evaluate(({ nextText, nextOptions }) => {
        const e2e = window.__e2e;
        if (!e2e?.simulateCapturedText) throw new Error("window.__e2e.simulateCapturedText is unavailable");
        return e2e.simulateCapturedText(nextText, nextOptions);
      }, { nextText: String(text), nextOptions: options });
    },
    async uploadImage(filePath) {
      const resolved = path.resolve(String(filePath));
      await page.locator("#image-upload").setInputFiles(resolved);
      return resolved;
    },
    async hotkey(action) {
      return page.evaluate((nextAction) => {
        const e2e = window.__e2e;
        if (!e2e?.dispatchPlaybackHotkey) throw new Error("window.__e2e.dispatchPlaybackHotkey is unavailable");
        return e2e.dispatchPlaybackHotkey(nextAction);
      }, action);
    },
    async readingPreviewState() {
      return page.evaluate(() => window.__e2e?.getReadingPreviewState?.());
    },
    async uiState() {
      return page.evaluate(() => window.__e2e?.getRecentUiState?.());
    },
    snapshot,
    async inspect(options = {}) {
      const screenshotPath = options.screenshot === false ? null : await this.screenshot({ fullPage: true });
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        pages: await listBrowserPages(browser, page),
        services: await serviceState(),
        ui: await this.uiState(),
        reading: await this.readingPreviewState(),
        snapshot: await snapshot({ maxItems: options.maxItems ?? 120 }),
        logs: logs.tail({ lines: options.logLines ?? 40 }),
        screenshot: screenshotPath
      };
    },
    services: {
      state: serviceState,
      select: selectService,
      launchSelected: launchSelectedServices,
      stopSelected: stopSelectedServices,
      async waitFor(expected, options = {}) {
        const timeoutMs = Number.isFinite(Number(options.timeoutMs ?? options.timeout))
          ? Number(options.timeoutMs ?? options.timeout)
          : 120000;
        const expectedState = { ...expected };
        const expectedChips = {};
        for (const key of ["detect", "ocr", "tts"]) {
          if (Object.prototype.hasOwnProperty.call(expectedState, key)) {
            expectedChips[key] = expectedState[key];
            delete expectedState[key];
          }
        }
        if (Object.keys(expectedChips).length > 0) {
          expectedState.chips = { ...(expectedState.chips ?? {}), ...expectedChips };
        }
        await expect.poll(serviceState, {
          timeout: timeoutMs,
          intervals: options.intervals ?? [500, 1000, 2000, 5000]
        }).toMatchObject(expectedState);
        return serviceState();
      }
    }
  };
}

async function executeSnippet({ browser, page, source }) {
  const context = page.context();
  const logs = createLogsHelper();
  const debug = createDebugHelper(page, browser, logs);
  const runner = new Function(
    "page",
    "context",
    "browser",
    "expect",
    "fs",
    "path",
    "logs",
    "debug",
    `"use strict"; return (async () => {\n${source}\n})();`
  );
  return runner(page, context, browser, expect, fs, path, logs, debug);
}

async function run(options) {
  const source = await readSnippet(options);
  let browser;
  const endpoint = options.endpoint === DEFAULT_ENDPOINT ? resolveDefaultEndpoint() : options.endpoint;

  try {
    browser = await chromium.connectOverCDP(endpoint, {
      timeout: options.timeout,
      isLocal: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to Electron CDP endpoint ${endpoint}.\n` +
      "Start the agent debug app first with: npm run dev:electron:agent\n" +
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
  const missingLogs = createLogsHelper().tail({ path: "missing-test-log-file.log" });
  if (!missingLogs.missing || !Array.isArray(missingLogs.entries)) throw new Error("logs helper missing-file handling failed");
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
