/**
 * Shared loopback + same-origin guards for Bridge routes that serve a LOCAL
 * browser surface (no `TEAMLEAD_API_TOKEN` in the page) and must be mounted
 * BEFORE the `/api` Bearer middleware.
 *
 * Extracted from fleet-routes.ts (FLY-247) so both the Fleet Console and the
 * FLY-286 web-local review route share ONE implementation (codex design review
 * R1#2/#5). fleet-routes.ts re-exports these for backward compatibility — no
 * behaviour change.
 */

/**
 * Anti-DNS-rebinding guard (Codex FLY-247 R1 HIGH-1): the `Host` header is
 * attacker-controllable, so before trusting it as the same-origin baseline we
 * require it to be a real loopback host. A rebinding domain (evil.com →
 * 127.0.0.1) carries a non-loopback Host and is rejected. Returns the validated
 * self-origin (`http://<host>`), or null when the host is not loopback.
 */
export function loopbackSelfOrigin(host: string | undefined): string | null {
	if (typeof host !== "string" || host.length === 0) return null;
	const hostname = host.replace(/:\d+$/, ""); // strip :port (IPv4 / host / [::1])
	if (
		hostname !== "127.0.0.1" &&
		hostname !== "localhost" &&
		hostname !== "[::1]"
	) {
		return null;
	}
	return `http://${host}`;
}

/** Same-origin guard: Origin/Referer must be the Bridge's own loopback origin. */
export function isSameOrigin(
	headers: Record<string, string | undefined>,
	selfOrigin: string,
): boolean {
	const origin = headers.origin ?? headers.Origin;
	if (origin) return origin === selfOrigin;
	const referer = headers.referer ?? headers.Referer;
	if (referer)
		return referer.startsWith(`${selfOrigin}/`) || referer === selfOrigin;
	// No Origin/Referer (e.g. a non-browser caller) — treated as same-origin is
	// NOT assumed; require one of them to be present and matching.
	return false;
}
