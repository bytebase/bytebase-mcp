import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "../dist/browser.js";

const url = "https://bb.example.com/api/oauth2/authorize?client_id=a&state=b|c^d%25e";

test("browserCommand opens http(s) sign-in URLs with each platform's opener", () => {
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand("http://localhost:8080/api/oauth2/authorize?x=1", "linux"), {
    command: "xdg-open",
    args: ["http://localhost:8080/api/oauth2/authorize?x=1"],
  });
});

test("browserCommand on Windows passes the URL to rundll32 untouched, never through cmd", () => {
  assert.deepEqual(browserCommand(url, "win32"), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
});

test("browserCommand opens nothing that is not http(s)", () => {
  for (const other of ["file:///etc/passwd", "ms-settings:", "vscode://x/y", "ftp://bb.example.com/", "not a url"]) {
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.equal(browserCommand(other, platform), undefined, `${other} on ${platform}`);
    }
  }
});
