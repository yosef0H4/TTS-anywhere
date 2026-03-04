import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    viewport: { width: 1400, height: 900 },
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120000
  }
});
