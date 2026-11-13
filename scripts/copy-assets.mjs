// Copies the generated tool definitions next to the compiled output, where
// src/tools.ts reads them at runtime (import.meta.url relative).
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.copyFileSync(path.join(root, "src", "tools.json"), path.join(root, "dist", "tools.json"));
fs.chmodSync(path.join(root, "dist", "index.js"), 0o755);
