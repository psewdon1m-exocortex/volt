import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18185,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18184",
        changeOrigin: false,
      },
      "/robots.txt": {
        target: "http://127.0.0.1:18184",
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: false,
  },
});
