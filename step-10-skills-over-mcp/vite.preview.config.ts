import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Dev server for preview/: a local stand-in for the chat host (see preview/preview.ts). */
export default defineConfig({ root: resolve(import.meta.dirname, "preview"), server: { port: 5199, strictPort: true } });
