import { mcpEndpoint } from "./config.js";

/** What the instance's protected-resource document says about the configured URL. */
export type InstanceProbe =
  | { kind: "bytebase" }
  /** The server answered, with anything but Bytebase's document for this URL. */
  | { kind: "not-bytebase"; detail: string }
  /** No answer (network error or timeout), or a gateway's 502, 503 or 504. */
  | { kind: "unreachable"; detail: string };

/** A reverse proxy's answer while the Bytebase behind it is down or restarting (docs/DESIGN.md, States). */
export function isGatewayStatus(status: unknown): boolean {
  return status === 502 || status === 503 || status === 504;
}

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
    const detail = `HTTP ${response.status} for ${url.pathname}`;
    return isGatewayStatus(response.status) ? { kind: "unreachable", detail } : { kind: "not-bytebase", detail };
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
