import { mcpEndpoint } from "./config.js";

/** What the instance's protected-resource document says about the configured URL. */
export type InstanceProbe =
  | { kind: "bytebase" }
  /** The server answered, with anything but Bytebase's document for this URL. */
  | { kind: "not-bytebase"; detail: string }
  /** No answer: network error or timeout. */
  | { kind: "unreachable"; detail: string };

/**
 * Asks GET <base>/.well-known/oauth-protected-resource/mcp. A Bytebase instance
 * with MCP answers with a document whose `resource` is <base>/mcp.
 */
export async function probeInstance(base: URL, signal?: AbortSignal): Promise<InstanceProbe> {
  const endpoint = mcpEndpoint(base);
  const url = new URL(endpoint.toString());
  url.pathname = `/.well-known/oauth-protected-resource${endpoint.pathname}`;
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    return { kind: "unreachable", detail: errorText(err) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "not-bytebase", detail: `HTTP ${response.status} for ${url.pathname}` };
  }
  try {
    const body = (await response.json()) as { resource?: unknown };
    const expected = endpoint.toString().replace(/\/+$/, "");
    if (typeof body.resource === "string" && body.resource.replace(/\/+$/, "") === expected) return { kind: "bytebase" };
    return { kind: "not-bytebase", detail: `its protected-resource document names ${String(body.resource)}, not ${expected}` };
  } catch {
    return { kind: "not-bytebase", detail: `${url.pathname} is not a protected-resource document` };
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
