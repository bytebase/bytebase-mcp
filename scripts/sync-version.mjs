// Propagates package.json's version into server.json, whose version field is
// what the MCP Registry publish step reads. Wired as the "version" lifecycle
// script, so `npm version <bump>` runs it and commits the result.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const version = read("package.json").version;

const serverFile = path.join(root, "server.json");
const server = JSON.parse(fs.readFileSync(serverFile, "utf8"));
server.version = version;
const pkg = server.packages.find((p) => p.identifier === "@bytebase/bytebase-mcp");
if (!pkg) throw new Error("server.json: no @bytebase/bytebase-mcp package entry");
pkg.version = version;
fs.writeFileSync(serverFile, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${version}`);
