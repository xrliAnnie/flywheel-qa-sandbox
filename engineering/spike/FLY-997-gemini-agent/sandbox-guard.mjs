// FLY-997 sandbox guard — executable, fail-closed (plan §4, Codex R1-3).
// Every harness entrypoint MUST call assertSandbox() before doing anything,
// and every outbound HTTP request MUST go through assertLocalhostUrl().

const FORBIDDEN_ENV = [
	"BRIDGE_URL",
	"FLYWHEEL_BRIDGE_URL",
	"TEAMLEAD_API_TOKEN",
];
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Guard 2: fail-closed if production Bridge env vars are present. */
export function assertSandbox() {
	const present = FORBIDDEN_ENV.filter((k) => process.env[k]);
	if (present.length > 0) {
		console.error(
			`[sandbox-guard] FAIL-CLOSED: forbidden env present: ${present.join(", ")}\n` +
				"This harness must never run with production Bridge coordinates. " +
				"Launch via ./run.sh (which scrubs them).",
		);
		process.exit(78); // EX_CONFIG
	}
	if (!process.env.GEMINI_API_KEY) {
		console.error("[sandbox-guard] GEMINI_API_KEY missing — cannot run spike.");
		process.exit(78);
	}
	return { guard: "env", ok: true, checked: FORBIDDEN_ENV };
}

/** Guard 1: outbound tool-client URLs must be loopback-only. */
export function assertLocalhostUrl(url) {
	const u = new URL(url);
	if (!ALLOWED_HOSTS.has(u.hostname)) {
		throw new Error(
			`[sandbox-guard] blocked non-localhost tool URL: ${u.origin} — mock-only invariant violated`,
		);
	}
	return u;
}

/** Guard 4: origin audit trail — call for every outbound tool HTTP request. */
const seenOrigins = new Set();
export function recordOrigin(url) {
	seenOrigins.add(new URL(url).origin);
}
export function getSeenOrigins() {
	return [...seenOrigins].sort();
}
