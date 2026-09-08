import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';

export type RequestGuard = (headers: { host?: string; origin?: string }) => boolean;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Host/Origin policy for API and WebSocket requests. Pure given its inputs;
 * `bindHost` is the `--host` value. An Origin, when sent, must name the same
 * host:port as Host (blocks cross-site pages). On a loopback bind, Host must be
 * loopback too. On any other bind, Host must be an IP literal, loopback, the
 * bind host, or one of `names` (the machine's own hostnames by default). Both
 * rules block DNS rebinding: an attacker's domain is never an IP literal and
 * never one of ours.
 */
export function requestGuard(bindHost: string, names: string[] = ownNames()): RequestGuard {
  const loopback = LOOPBACK.has(bindHost);
  const allowed = new Set([...LOOPBACK, bindHost.toLowerCase(), ...names.map((n) => n.toLowerCase())]);
  return ({ host, origin }) => {
    if (!host) return false;
    if (origin != null) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return false;
      }
      if (originHost !== host) return false;
    }
    const name = hostnameOf(host).toLowerCase();
    if (loopback) return LOOPBACK.has(name);
    return isIP(name) !== 0 || allowed.has(name);
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
