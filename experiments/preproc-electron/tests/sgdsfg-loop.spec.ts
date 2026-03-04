import fs from "node:fs/promises";
import path from "node:path";
import { test } from "@playwright/test";
import { loadFixture, readState, runDetect } from "./helpers/lab";

const OUT_DIR = path.resolve("test-artifacts", "sgdsfg-loop");

test("sgdsfg image loop snapshot", async ({ page }) => {
  await fs.mkdir(OUT_DIR, { recursive: true });

  await page.goto("/");
  await loadFixture(page, "sgdsfg.webp");

  await runDetect(page);
  const state1 = await readState(page);
  await fs.writeFile(path.join(OUT_DIR, "state-default.json"), JSON.stringify(state1, null, 2), "utf-8");
  await page.getByTestId("paste-target").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(OUT_DIR, "sgdsfg-default.png")
  });

  await page.evaluate(() => {
    window.lab.batchSet({
      contrast: 1.3,
      brightness: 8,
      "median-height-fraction": 0.3,
      "min-width-ratio": 0.0,
      "min-height-ratio": 0.0
    });
  });
  await runDetect(page);

  const state2 = await readState(page);
  await fs.writeFile(path.join(OUT_DIR, "state-tuned.json"), JSON.stringify(state2, null, 2), "utf-8");
  await page.getByTestId("paste-target").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(OUT_DIR, "sgdsfg-tuned.png")
  });
});
