// -----------------------------------------------------------------------------
// Token protection for the MCP endpoint.
//
// Claude connectors can only be given a URL, so the token may travel in the
// path (/mcp/<token>). Copilot Studio sends headers, so it may also arrive as
// "x-api-key: <token>" or "Authorization: Bearer <token>". Comparison is in
// constant time, and repeated failures from one address are throttled.
//
//   MCP_ACCESS_TOKEN            unset  -> unchanged: open, with a warning
//                               set    -> the token is required
//   MCP_ALLOW_UNAUTHENTICATED   "true" -> while switching clients over, a
//                                         request with NO token is still let
//                                         through (a wrong token never is).
//                                         Remove once every client is updated.
// -----------------------------------------------------------------------------

import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

const TOKEN = process.env.MCP_ACCESS_TOKEN ?? "";
const ALLOW_OPEN = /^(1|true|yes)$/i.test(process.env.MCP_ALLOW_UNAUTHENTICATED ?? "");

export function authMode(): string {
  if (!TOKEN) return "OPEN — MCP_ACCESS_TOKEN is not set; anyone with the URL can use this server";
  if (ALLOW_OPEN) return "token accepted; requests without one still allowed (MCP_ALLOW_UNAUTHENTICATED) — remove once clients are updated";
  return "token required";
}

/** Is this an MCP URL ("/mcp" or "/mcp/<token>", with or without a query)? */
export function parseMcpPath(url: string | undefined, base = "/mcp"): { isMcp: boolean; pathToken: string | null } {
  const path = String(url ?? "").split("?")[0];
  if (path === base || path === `${base}/`) return { isMcp: true, pathToken: null };
  if (path.startsWith(`${base}/`)) {
    const rest = path.slice(base.length + 1);
    if (rest && !rest.includes("/")) {
      try { return { isMcp: true, pathToken: decodeURIComponent(rest) }; } catch { return { isMcp: true, pathToken: rest }; }
    }
  }
  return { isMcp: false, pathToken: null };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd ?? "").split(",")[0].trim();
  return first || req.socket.remoteAddress || "unknown";
}

function recentFailures(ip: string): number[] {
  const now = Date.now();
  const hits = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, hits);
  if (failures.size > 5000) failures.clear();
  return hits;
}

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/** Decide whether a request may reach the MCP server. */
export function checkMcpAuth(req: IncomingMessage, pathToken: string | null): AuthResult {
  if (!TOKEN) return { ok: true };

  const ip = clientIp(req);
  if (recentFailures(ip).length >= MAX_FAILURES) {
    return { ok: false, status: 429, message: "Too many failed attempts. Wait fifteen minutes and try again." };
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? "").trim());
  const apiKey = req.headers["x-api-key"];
  const supplied = pathToken ?? (bearer ? bearer[1].trim() : (Array.isArray(apiKey) ? apiKey[0] : apiKey ?? "").trim());

  if (supplied && same(supplied, TOKEN)) return { ok: true };
  if (!supplied && ALLOW_OPEN) return { ok: true };

  recentFailures(ip).push(Date.now());
  return {
    ok: false,
    status: 401,
    message: "Unauthorized: use the URL ending /mcp/<token>, or send the token as \"x-api-key\" or \"Authorization: Bearer\".",
  };
}

/** Write a JSON-RPC style refusal. */
export function refuse(res: { writeHead: (s: number, h: Record<string, string>) => unknown; end: (b: string) => unknown }, r: { status: number; message: string }): void {
  res.writeHead(r.status, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mcp"' });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: r.message } }));
}
