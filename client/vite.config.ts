/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // Vitest stubs CSS imports to "" by default — which would silently empty
    // the `?raw` stylesheet reads that tokens.test.ts asserts token exactness
    // against. Process CSS so the sheets under test are the real ones.
    css: true,
  },
});
