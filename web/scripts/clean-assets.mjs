// Remove stale hashed build artifacts from the output dir before a fresh build.
// The backend serves src/static/admin, and vite runs with emptyOutDir:false to
// preserve the hand-kept png/svg icons — so we clear only assets/ ourselves.
import { rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

// scripts/ is one level below web/, and the output dir is grok-register/src/static/admin.
const assetsDir = fileURLToPath(new URL("../../src/static/admin/assets", import.meta.url));

try {
  await rm(assetsDir, { recursive: true, force: true });
  console.log("cleaned", assetsDir);
} catch (err) {
  console.warn("clean skipped:", err.message);
}
