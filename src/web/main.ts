import { startWebApp } from "./app";

window.electronAPI?.recordStartupPhase?.("renderer.module.entry", {
  readyState: document.readyState
});

startWebApp();
