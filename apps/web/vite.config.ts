import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // 0.0.0.0：允许 Docker 内的 Playwright / 局域网访问
    allowedHosts: ["host.docker.internal"],
    proxy: {
      // 调度器 API（ARCHITECTURE §7）
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
