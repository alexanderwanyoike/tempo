import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples")) {
            return "three-postfx";
          }

          if (id.includes("node_modules/three")) {
            return "three-core";
          }

          if (id.includes("node_modules/zod")) {
            return "zod-runtime";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
