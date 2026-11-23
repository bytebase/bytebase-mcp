const FIRST_MS = 1000;
const CEILING_MS = 5 * 60 * 1000;
const RETRIES = 10;

/**
 * The waits before each retry of opening a session when the instance cannot be
 * reached at startup (docs/DESIGN.md, D5): doubling from one second up to a
 * five-minute ceiling, ten retries in all, after which the proxy stops until
 * the client restarts it.
 */
export function startupRetryDelaysMs(): number[] {
  return Array.from({ length: RETRIES }, (_, i) => Math.min(FIRST_MS * 2 ** i, CEILING_MS));
}
