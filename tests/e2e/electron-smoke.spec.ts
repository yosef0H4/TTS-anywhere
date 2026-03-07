import { _electron as electron, expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("electron app launches and renders playback controls", async () => {
  const distMain = path.resolve("dist-electron", "main.js");
  if (!fs.existsSync(distMain)) {
    test.skip();
  }

  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4173"
    }
  });

  const page = await app.firstWindow();
  await page.waitForSelector("#btn-play");
  await expect(page.locator("#btn-play")).toBeVisible();
  await app.close();
});
