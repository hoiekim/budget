import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      client: path.resolve(__dirname, "./src/client"),
      server: path.resolve(__dirname, "./src/server"),
      common: path.resolve(__dirname, "./src/common"),
    },
  },
  root: ".",
  publicDir: "public",
  build: {
    outDir: "build/client",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3005",
        changeOrigin: true,
      },
    },
  },
});
