export interface BrowserCommand {
  command: string;
  args: string[];
}

/**
 * How to open a sign-in URL on a platform, or undefined to only print it
 * (docs/DESIGN.md, D5). The URL comes from the instance's OAuth metadata, so
 * only http(s) is opened, and never through a shell: `cmd` would run what a
 * `|` or `^` in the query introduces.
 */
export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand | undefined {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return undefined;
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}
