import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    watch: {
      ignored: [
        "**/services/text_processing/paddle/.venv/**",
        "**/services/text_processing/paddle/.venv-win/**",
        "**/services/text_processing/paddle/.venv*/**",
      ]
    }
  }
});
