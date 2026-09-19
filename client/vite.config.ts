import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(process.cwd(), "client"),
  plugins: [react()],
  build: { outDir: resolve(process.cwd(), "dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:5174" },
  },
});
