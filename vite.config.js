import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    host: "0.0.0.0", // expose on LAN so you can test from phone on same WiFi
    port: 5173,
  },

  build: {
    // Cloudflare Pages compatible output
    outDir: "dist",
    target: "es2020",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Split large deps to help with Cloudflare's 25MB limit
        manualChunks: {
          three: ["three"],
          rapier: ["@dimforge/rapier3d-compat"],
          r3f: ["@react-three/fiber", "@react-three/drei", "@react-three/rapier"],
        },
      },
    },
  },

  optimizeDeps: {
    // Rapier WASM needs special handling
    exclude: ["@dimforge/rapier3d-compat"],
  },
});