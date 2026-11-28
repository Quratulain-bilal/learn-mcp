import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Builds ONE widget (named by the WIDGET environment variable) into ONE self-contained
 * HTML file: React, the ext-apps App class and the CSS are all inlined. The chat host
 * renders it in a sandboxed iframe whose CSP blocks loading scripts from anywhere else,
 * so nothing may be fetched at runtime. scripts/build-widgets.ts runs this per widget.
 */
const widget = process.env.WIDGET;
if (!widget) throw new Error("Set WIDGET to the widget folder name, e.g. orders-table.");

export default defineConfig({
  root: resolve(import.meta.dirname, "widgets", widget),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, "dist", "widgets", widget),
    emptyOutDir: true,
    // Small enough to read in the network tab; no source maps shipped into the chat.
    sourcemap: false,
  },
  logLevel: "warn",
});
