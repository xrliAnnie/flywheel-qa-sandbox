import { afterEach, describe, expect, it } from "vitest";
import { resolveBridgeUrl } from "../Blueprint.js";

/**
 * FLY-137 wire-up fix — Bug 1: resolveBridgeUrl propagation.
 *
 * Production .env does not export TEAMLEAD_URL (only scripts/test-deploy.sh
 * does). When TEAMLEAD_URL is unset, Blueprint must fall back to a loopback
 * URL derived from TEAMLEAD_HOST/TEAMLEAD_PORT so the spawned Runner gets a
 * non-empty FLYWHEEL_BRIDGE_URL — otherwise `flywheel-comm stage set onboard`
 * exits 1 and the FLY-137 onboard preamble silently no-ops.
 */
describe("resolveBridgeUrl (FLY-137 wire-up fix)", () => {
	const ORIG = { ...process.env };
	afterEach(() => {
		// Restore env after each test
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIG)) delete process.env[k];
		}
		Object.assign(process.env, ORIG);
	});

	it("returns explicit TEAMLEAD_URL when set", () => {
		const env = { TEAMLEAD_URL: "http://10.0.0.5:8080" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://10.0.0.5:8080");
	});

	it("trims surrounding whitespace from TEAMLEAD_URL", () => {
		const env = {
			TEAMLEAD_URL: "  http://localhost:9876  ",
		} as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://localhost:9876");
	});

	it("treats empty TEAMLEAD_URL as unset (falls back)", () => {
		const env = { TEAMLEAD_URL: "" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://127.0.0.1:9876");
	});

	it("falls back to 127.0.0.1:9876 when TEAMLEAD_URL is unset (production case)", () => {
		const env = {} as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://127.0.0.1:9876");
	});

	it("honors TEAMLEAD_PORT in fallback", () => {
		const env = { TEAMLEAD_PORT: "9999" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://127.0.0.1:9999");
	});

	it("honors loopback TEAMLEAD_HOST in fallback", () => {
		const env = {
			TEAMLEAD_HOST: "localhost",
			TEAMLEAD_PORT: "9876",
		} as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://localhost:9876");
	});

	it("brackets IPv6 loopback ::1 in URL authority (Codex R1 MEDIUM fix)", () => {
		// RFC 3986 §3.2.2 requires IPv6 literals to be bracketed in URL
		// authority. `config.ts` ALLOWED_HOSTS accepts `::1`, so the resolver
		// must emit `http://[::1]:9876` — NOT `http://::1:9876` (invalid URL,
		// `flywheel-comm` URL parsing would fail).
		const env = {
			TEAMLEAD_HOST: "::1",
			TEAMLEAD_PORT: "9876",
		} as NodeJS.ProcessEnv;
		const url = resolveBridgeUrl(env);
		expect(url).toBe("http://[::1]:9876");
		// Defense-in-depth: the emitted string must parse as a valid URL.
		expect(() => new URL(url as string)).not.toThrow();
	});

	it("brackets IPv6 loopback ::1 even when TEAMLEAD_PORT is the default", () => {
		const env = { TEAMLEAD_HOST: "::1" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://[::1]:9876");
	});

	it("returns undefined when TEAMLEAD_HOST is non-loopback and TEAMLEAD_URL unset", () => {
		// Defense-in-depth: if the operator configured a non-loopback host but
		// forgot TEAMLEAD_URL, refuse to guess the wrong interface. Caller will
		// fall back to `undefined` and the TmuxAdapter skips FLYWHEEL_BRIDGE_URL
		// injection — same legacy behavior, no silent miswiring.
		const env = { TEAMLEAD_HOST: "10.0.0.5" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBeUndefined();
	});

	it("returns undefined when TEAMLEAD_PORT is invalid", () => {
		const env = { TEAMLEAD_PORT: "not-a-number" } as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBeUndefined();
	});

	it("returns undefined when TEAMLEAD_PORT is out of range", () => {
		expect(
			resolveBridgeUrl({ TEAMLEAD_PORT: "0" } as NodeJS.ProcessEnv),
		).toBeUndefined();
		expect(
			resolveBridgeUrl({ TEAMLEAD_PORT: "70000" } as NodeJS.ProcessEnv),
		).toBeUndefined();
	});

	it("explicit TEAMLEAD_URL wins over TEAMLEAD_HOST/PORT", () => {
		const env = {
			TEAMLEAD_URL: "http://override.example:1234",
			TEAMLEAD_HOST: "127.0.0.1",
			TEAMLEAD_PORT: "9999",
		} as NodeJS.ProcessEnv;
		expect(resolveBridgeUrl(env)).toBe("http://override.example:1234");
	});

	it("defaults match packages/teamlead/src/config.ts (host=127.0.0.1, port=9876)", () => {
		// Anti-drift: if config.ts defaults change, this test reminds us to
		// re-align the resolver. The fallback origin is the Bridge's own URL.
		expect(resolveBridgeUrl({} as NodeJS.ProcessEnv)).toBe(
			"http://127.0.0.1:9876",
		);
	});
});
