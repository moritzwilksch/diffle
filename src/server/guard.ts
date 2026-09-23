import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';

/**
 * Returns null for an accepted request, or a message naming the header that failed
 * and either the origin already trusted or how to trust one.
 */
export type RequestGuard = (headers: { host?: string; origin?: string }) => string | null;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNCONFIGURED = 'if a reverse proxy sent it, trust that origin with --allowed-origin';

/**
 * Restricts API and WebSocket requests to local hosts and the configured public origin.
 * Proxies may preserve the public Host or rewrite it to an allowed upstream Host.
 * Forwarded headers never grant trust; a public Origin must be explicitly configured.
 */
export function requestGuard(bindHost: string, names: string[] = ownNames(), allowedOrigin?: string): RequestGuard {
  const loopback = LOOPBACK.has(bindHost);
  const allowed = new Set([...LOOPBACK, bindHost.toLowerCase(), ...names.map((n) => n.toLowerCase())]);
  const publicHost = allowedOrigin == null ? undefined : new URL(allowedOrigin).host;
  // Name the configured origin: it can differ from the rejected one only in the scheme, which
  // makes an Origin and a Host that print identically look like a contradiction.
  const hint = allowedOrigin == null ? UNCONFIGURED : `allowed origin is "${allowedOrigin}"`;
  return ({ host, origin }) => {
    if (!host) return 'missing Host header';
    const name = hostnameOf(host).toLowerCase();
    const localHost = loopback ? LOOPBACK.has(name) : isIP(name) !== 0 || allowed.has(name);
    const proxyHost = publicHost != null && host.toLowerCase() === publicHost;
    if (!localHost && !proxyHost) return `forbidden Host "${host}"; ${hint}`;
    if (origin == null || (allowedOrigin != null && origin === allowedOrigin)) return null;
    // A public Host must not make another scheme or port on that origin trusted.
    if (!proxyHost && parseHost(origin) === host) return null;
    return `forbidden Origin "${origin}" for Host "${host}"; ${hint}`;
  };
}

/** The host of a syntactically valid origin; undefined for `null` and other non-URLs. */
function parseHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/** The machine's hostname, its short form, and its mDNS name, so LAN visitors can use any of them. */
function ownNames(): string[] {
  const full = osHostname();
  const short = full.split('.')[0]!;
  return [full, short, `${short}.local`];
}

/** Hostname without port; brackets stripped from IPv6 literals. */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  const i = host.lastIndexOf(':');
  // A bare IPv6 without brackets is not a valid Host header; treat it whole.
  return i === -1 || isIP(host) ? host : host.slice(0, i);
}
