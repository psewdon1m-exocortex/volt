import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18185,
    proxy: {
      "/api": "http://127.0.0.1:18184",
      "/robots.txt": "http://127.0.0.1:18184",
    },
  },
  build: {
    sourcemap: false,
  },
});
