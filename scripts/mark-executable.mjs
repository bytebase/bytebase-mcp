// Marks the compiled entry point executable, since npm links it as a bin.
import fs from "node:fs";
import path from "node:path";

fs.chmodSync(path.join(import.meta.dirname, "..", "dist", "index.js"), 0o755);
