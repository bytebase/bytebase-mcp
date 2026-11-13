// Rewrites the tools table in README.md between the tools:start/tools:end
// markers from src/tools.json. Called by sync-tools.mjs after a dump.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const readmeFile = path.join(root, "README.md");
const bundle = JSON.parse(fs.readFileSync(path.join(root, "src", "tools.json"), "utf8"));

const firstSentence = (text) => {
  const line = (text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : line).replace(/\|/g, "\\|").trim();
};

const rows = bundle.tools.map((t) => `| \`${t.name}\` | ${firstSentence(t.description)} |`).join("\n");
const table = [
  `Generated from Bytebase ${bundle.bytebaseVersion}.`,
  "",
  "| Tool | Purpose |",
  "| --- | --- |",
  rows,
].join("\n");

const readme = fs.readFileSync(readmeFile, "utf8");
const start = "<!-- tools:start -->";
const end = "<!-- tools:end -->";
const a = readme.indexOf(start);
const b = readme.indexOf(end);
if (a === -1 || b === -1 || b < a) throw new Error("README.md: tools markers not found");
const updated = `${readme.slice(0, a + start.length)}\n${table}\n${readme.slice(b)}`;
if (updated !== readme) {
  fs.writeFileSync(readmeFile, updated);
  console.log(`README.md: tools table updated (${bundle.tools.length} tools)`);
}
