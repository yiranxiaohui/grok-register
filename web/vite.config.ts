import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The FastAPI backend serves the built HTML at /admin and /admin/accounts, and
// mounts StaticFiles at /static -> src/static. So the built assets must load
// from /static/admin/... regardless of which admin path renders the page.
// Output goes straight into src/static/admin so the backend serves it unchanged.
export default defineConfig({
  plugins: [react()],
  base: "/static/admin/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../src/static/admin",
    emptyOutDir: false, // keep grok-icon.png / *.svg that the backend also serves
    assetsDir: "assets",
    rollupOptions: {
      // Input filename becomes the output filename, so the backend keeps
      // finding static/admin/accounts.html.
      input: fileURLToPath(new URL("./accounts.html", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev: forward all admin + api traffic to the running backend.
      "/admin": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
