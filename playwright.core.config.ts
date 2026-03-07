import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
    viewport: { width: 1400, height: 900 },
    screenshot: "only-on-failure",
    trace: "off",
    video: "off"
  },
  reporter: [["line"]],
  webServer: {
    command: "npm run build:web && npx vite preview --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 120000
  },
  projects: [
    {
      name: "core-web",
      testMatch: ["**/playback-stability.spec.ts", "**/typing-gate.spec.ts", "**/tts-dedupe.spec.ts"]
    }
  ]
});
