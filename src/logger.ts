/**
 * stdout is the JSON-RPC channel. A single stray write to it corrupts the
 * protocol and kills the server with an opaque error, so diagnostics go to
 * stderr — always. This module exists so nothing in the codebase needs to reach
 * for console.log (which writes to stdout) and accidentally do that.
 */
export const logger = {
  info(message: string, ...rest: unknown[]): void {
    process.stderr.write(`INFO:needle-mcp:${format(message, rest)}\n`);
  },
  warn(message: string, ...rest: unknown[]): void {
    process.stderr.write(`WARNING:needle-mcp:${format(message, rest)}\n`);
  },
  error(message: string, ...rest: unknown[]): void {
    process.stderr.write(`ERROR:needle-mcp:${format(message, rest)}\n`);
  },
};

function format(message: string, rest: readonly unknown[]): string {
  if (rest.length === 0) return message;
  return `${message} ${rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join(" ")}`;
}
