import fs from "node:fs";
import path from "node:path";
import { NodeHotkey } from "nodehotkey";

if (process.platform !== "win32") {
  console.error("[nodehotkey-manual-test] Windows-only");
  process.exit(1);
}

const args = process.argv.slice(2);
const hotkeyArgIndex = args.findIndex((a) => a === "--hotkey");
const hotkey = hotkeyArgIndex >= 0 ? args[hotkeyArgIndex + 1] : "ctrl+shift+alt+s";

const outDir = path.join(process.cwd(), "services", "nodehotkey", "captures");
fs.mkdirSync(outDir, { recursive: true });

let count = 0;

const hk = new NodeHotkey({
  initialHotkey: hotkey,
  events: {
    onHotkeyRegistered: (label) => console.log(`[nodehotkey-manual-test] hotkey.registered ${label}`),
    onHotkeySwitched: (label) => console.log(`[nodehotkey-manual-test] hotkey.switched ${label}`),
    onCaptureStart: (start) => console.log(`[nodehotkey-manual-test] capture.start x=${start.x} y=${start.y} hotkey=${start.hotkey}`),
    onCaptureFinalize: (rect) => console.log(`[nodehotkey-manual-test] capture.finalize x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}`),
    onError: (error) => console.error(`[nodehotkey-manual-test] error ${error.message}`)
  }
});

hk.start();
console.log(`[nodehotkey-manual-test] started, hotkey=${hk.getHotkey()}`);
console.log("[nodehotkey-manual-test] hold hotkey, drag mouse, release base key to capture");
console.log("[nodehotkey-manual-test] press Ctrl+C to exit");

async function loop() {
  while (true) {
    const result = await hk.captureOnce();
    count += 1;
    const file = path.join(outDir, `capture-${String(count).padStart(3, "0")}.png`);
    fs.writeFileSync(file, result.pngBuffer);
    console.log(`[nodehotkey-manual-test] saved ${file} (${result.rect.width}x${result.rect.height})`);
  }
}

void loop().catch((error) => {
  console.error(`[nodehotkey-manual-test] loop failed ${String(error)}`);
});

process.on("SIGINT", () => {
  hk.stop();
  console.log("[nodehotkey-manual-test] stopped");
  process.exit(0);
});
