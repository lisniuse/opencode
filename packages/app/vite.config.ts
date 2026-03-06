import { defineConfig } from "vite"
import desktopPlugin from "./vite"

export default defineConfig({
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: ["chrome89", "edge89", "firefox78", "safari14"],
    // sourcemap: true,
    rollupOptions: {
      external: [],
    },
  },
  optimizeDeps: {
    include: ["diff", "@pierre/diffs"],
  },
  base: "./",
  css: {
    transformer: "lightningcss",
    lightningcss: {
      targets: {
        chrome: 89,
        edge: 89,
        firefox: 78,
        safari: 14,
      },
    },
  },
})
