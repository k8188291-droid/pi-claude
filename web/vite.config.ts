import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開發時把 /anthropic/* 轉送到 Anthropic API，和 server.mjs 在正式環境做的事一樣。
const upstream = process.env.UPSTREAM_URL ?? "https://api.anthropic.com";

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1024 },
  server: {
    proxy: {
      "/anthropic": {
        target: upstream,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ""),
      },
    },
  },
});
