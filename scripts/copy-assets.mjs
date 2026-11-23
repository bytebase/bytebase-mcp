// Copies the bundled snapshot next to the compiled output, where src/tools.ts
// reads it, and marks the entry point executable, since npm links it as a bin.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
fs.copyFileSync(path.join(root, "src", "tools.json"), path.join(root, "dist", "tools.json"));
fs.chmodSync(path.join(root, "dist", "index.js"), 0o755);
