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
  root: "src/client",
  build: {
    outDir: "../../build/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "src/client/index.html",
        sw: "src/client/sw.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "[name].js" : "assets/[name]-[hash].js",
      },
    },
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
