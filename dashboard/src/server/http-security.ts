import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseHost(value: string): { host: string; hostname: string } | null {
  try {
    const url = new URL(`http://${value}`);
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase().replace(/^\[|\]$/g, "") };
  } catch {
    return null;
  }
}

export function isLoopbackHost(value: string): boolean {
  const parsed = parseHost(value);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
}

function sameToken(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface HttpSecurity {
  readonly token: string;
  readonly middleware: MiddlewareHandler;
}

export function createHttpSecurity(token = randomBytes(32).toString("base64url")): HttpSecurity {
  const middleware: MiddlewareHandler = async (context, next) => {
    const host = context.req.header("host") ?? new URL(context.req.url).host;
    const parsedHost = parseHost(host);
    if (!parsedHost || !LOOPBACK_HOSTS.has(parsedHost.hostname)) {
      return context.json({ error: "request host is not allowed" }, 403);
    }

    const origin = context.req.header("origin");
    if (origin) {
      let parsedOrigin: URL;
      try { parsedOrigin = new URL(origin); } catch { return context.json({ error: "request origin is not allowed" }, 403); }
      if (parsedOrigin.host.toLowerCase() !== parsedHost.host || !LOOPBACK_HOSTS.has(parsedOrigin.hostname.toLowerCase())) {
        return context.json({ error: "request origin is not allowed" }, 403);
      }
    }

    const fetchSite = context.req.header("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return context.json({ error: "cross-site request denied" }, 403);
    }

    if (MUTATING_METHODS.has(context.req.method.toUpperCase())) {
      const received = context.req.header("x-surtec-session") ?? "";
      if (!sameToken(received, token)) return context.json({ error: "valid session token required" }, 403);
    }

    await next();
  };
  return { token, middleware };
}

