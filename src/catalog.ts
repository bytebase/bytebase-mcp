import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { mcpEndpoint } from "./config.js";

/**
 * The public tool catalog a Bytebase server serves at GET <base>/mcp/catalog
 * (bytebase docs/design/mcp-public-catalog.md).
 */
export interface Catalog {
  instructions: string;
  instructionsWithoutForm: string;
  tools: Tool[];
}

/** What reading a catalog URL found. */
export type CatalogProbe =
  | { kind: "catalog"; catalog: Catalog }
  /** The server answered, with anything but a catalog. */
  | { kind: "not-catalog"; detail: string }
  /** No answer: network error or timeout. */
  | { kind: "unreachable"; detail: string };

/** Bytebase Cloud's catalog, read only by a proxy with no instance configured. */
export const PUBLIC_CATALOG_URL = "https://cloud.bytebase.com/mcp/catalog";

export function catalogUrl(base: URL): URL {
  const url = mcpEndpoint(base);
  url.pathname = `${url.pathname}/catalog`;
  return url;
}

/**
 * Reads a catalog. A server without the route answers 200 with the console's
 * page, so only a JSON body with a valid tool list counts.
 */
export async function fetchCatalog(url: URL, signal?: AbortSignal): Promise<CatalogProbe> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    return { kind: "unreachable", detail: errorText(err) };
  }
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    return { kind: "not-catalog", detail: `HTTP ${response.status} ${type || "without a content type"}` };
  }
  try {
    const body = (await response.json()) as Partial<Catalog>;
    const { tools } = ListToolsResultSchema.parse({ tools: body.tools });
    return {
      kind: "catalog",
      catalog: {
        instructions: typeof body.instructions === "string" ? body.instructions : "",
        instructionsWithoutForm: typeof body.instructionsWithoutForm === "string" ? body.instructionsWithoutForm : "",
        tools,
      },
    };
  } catch (err) {
    return { kind: "not-catalog", detail: `not a tool catalog: ${errorText(err)}` };
  }
}

/**
 * Whether base is a Bytebase instance's external URL: its protected-resource
 * document names <base>/mcp, as every Bytebase with MCP does.
 */
export async function namesItselfAsBytebase(base: URL, signal?: AbortSignal): Promise<boolean> {
  const endpoint = mcpEndpoint(base);
  const url = new URL(endpoint.toString());
  url.pathname = `/.well-known/oauth-protected-resource${endpoint.pathname}`;
  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = (await response.json()) as { resource?: unknown };
    return typeof body.resource === "string" && body.resource.replace(/\/+$/, "") === endpoint.toString().replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
