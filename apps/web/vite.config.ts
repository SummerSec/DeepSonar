import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // 0.0.0.0：允许 Docker 内的 Playwright / 局域网访问
    allowedHosts: ["host.docker.internal"],
    proxy: {
      // 调度器 API（ARCHITECTURE §7）+ /ws 实时流（§6.2）
      "/api": {
        target: process.env.DEEPSONAR_WEB_API_TARGET ?? "http://localhost:3100",
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
