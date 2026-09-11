import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';

export type RequestGuard = (headers: { host?: string; origin?: string }) => boolean;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Restricts API and WebSocket requests to local hosts and the configured public origin.
 * Proxies may preserve the public Host or rewrite it to an allowed upstream Host.
 * Forwarded headers never grant trust; a public Origin must be explicitly configured.
 */
export function requestGuard(bindHost: string, names: string[] = ownNames(), allowedOrigin?: string): RequestGuard {
  const loopback = LOOPBACK.has(bindHost);
  const allowed = new Set([...LOOPBACK, bindHost.toLowerCase(), ...names.map((n) => n.toLowerCase())]);
  const publicHost = allowedOrigin == null ? undefined : new URL(allowedOrigin).host;
  return ({ host, origin }) => {
    if (!host) return false;
    const name = hostnameOf(host).toLowerCase();
    const localHost = loopback ? LOOPBACK.has(name) : isIP(name) !== 0 || allowed.has(name);
    const proxyHost = publicHost != null && host.toLowerCase() === publicHost;
    if (!localHost && !proxyHost) return false;
    if (origin == null || (allowedOrigin != null && origin === allowedOrigin)) return true;
    // A public Host must not make another scheme or port on that origin trusted.
    if (proxyHost) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };
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
