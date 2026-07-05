import { describe, expect, it, vi } from "vitest";
import {
	type CanonicalRequest,
	ConfirmTokenStore,
} from "../bridge/fleet-admin.js";
import {
	type ApplyBody,
	type FleetRouteDeps,
	handleApply,
	handleStage,
	isSameOrigin,
	loopbackSelfOrigin,
} from "../bridge/fleet-routes.js";

describe("fleet-routes — loopbackSelfOrigin (anti-DNS-rebinding, HIGH-1)", () => {
	it("accepts loopback hosts (with/without port)", () => {
		expect(loopbackSelfOrigin("127.0.0.1:9876")).toBe("http://127.0.0.1:9876");
		expect(loopbackSelfOrigin("localhost:9876")).toBe("http://localhost:9876");
		expect(loopbackSelfOrigin("127.0.0.1")).toBe("http://127.0.0.1");
		expect(loopbackSelfOrigin("[::1]:9876")).toBe("http://[::1]:9876");
	});
	it("rejects non-loopback / rebinding / missing hosts", () => {
		expect(loopbackSelfOrigin("evil.test:9876")).toBeNull();
		expect(loopbackSelfOrigin("127.0.0.1.evil.test:9876")).toBeNull();
		expect(loopbackSelfOrigin("localhost.evil.test")).toBeNull();
		expect(loopbackSelfOrigin("169.254.1.1:9876")).toBeNull();
		expect(loopbackSelfOrigin(undefined)).toBeNull();
		expect(loopbackSelfOrigin("")).toBeNull();
	});
});

const ORIGIN = "http://127.0.0.1:9876";
const SAME = { origin: ORIGIN };

function fakeAudit() {
	const rows: Array<Record<string, unknown>> = [];
	return {
		rows,
		ok: true as boolean,
		record(rec: Record<string, unknown>) {
			if (!this.ok) return false;
			if (rec.event === "denied" && !rec.attemptId) return false;
			rows.push(rec);
			return true;
		},
		hasApplyResult: () => false,
		forBatch: () => rows,
		close: () => {},
	};
}

function deps(
	over: Partial<FleetRouteDeps> = {},
): FleetRouteDeps & { audit: ReturnType<typeof fakeAudit> } {
	const audit = fakeAudit();
	return {
		audit: audit as unknown as FleetRouteDeps["audit"] &
			ReturnType<typeof fakeAudit>,
		tokens: new ConfirmTokenStore(),
		currentModels: () =>
			new Map<string, string | null>([
				["geo-peter", "claude-fable-5"],
				["geo-oliver", null],
				["geo-mufasa", null], // Codex Lead — only null is allowed
			]),
		currentEfforts: () =>
			new Map<string, string | null>([
				["geo-peter", null],
				["geo-oliver", null],
				["geo-mufasa", null],
			]),
		allowedTargets: () =>
			new Map<string, Array<string | null>>([
				["geo-peter", ["claude-fable-5", null]],
				["geo-oliver", ["claude-fable-5", null]],
				["geo-mufasa", [null]], // Codex: model display-only
			]),
		allowedEffortTargets: () =>
			new Map<string, Array<string | null>>([
				["geo-peter", [null, "low", "medium", "high", "xhigh", "max"]],
				["geo-oliver", [null, "low", "medium", "high", "xhigh", "max"]],
				["geo-mufasa", [null]], // Codex: effort display-only
			]),
		configSha: () => "cfgsha",
		createLaunching: () => true,
		spawnEngine: () => true,
		...over,
	} as FleetRouteDeps & { audit: ReturnType<typeof fakeAudit> };
}

describe("fleet-routes — same-origin guard", () => {
	it("accepts matching Origin, rejects cross-origin / missing", () => {
		expect(isSameOrigin({ origin: ORIGIN }, ORIGIN)).toBe(true);
		expect(isSameOrigin({ referer: `${ORIGIN}/console` }, ORIGIN)).toBe(true);
		expect(isSameOrigin({ origin: "http://evil.test" }, ORIGIN)).toBe(false);
		expect(isSameOrigin({}, ORIGIN)).toBe(false);
	});
});

describe("fleet-routes — handleStage", () => {
	it("happy: builds canonical request, audits staged, issues a token", () => {
		const d = deps();
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-oliver", toModel: "claude-fable-5" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(200);
		expect(r.body.confirmToken).toBeTypeOf("string");
		const req = r.body.canonicalRequest as CanonicalRequest;
		expect(req.changes[0]).toEqual({
			key: "geo-oliver",
			from: { model: null },
			to: { model: "claude-fable-5" },
		});
		expect(d.audit.rows.some((x) => x.event === "staged")).toBe(true);
	});

	it("FLY-360: authorized 1M selector (claude-opus-4-8[1m]) → 200, to.model preserved exactly", () => {
		// The bracket id must survive the stage boundary byte-for-byte (no trim /
		// rewrite). allowedTargets authorizes it (in prod sourced from
		// CLAUDE_TIER_OPTIONS via computeAllowedModelTargets).
		const d = deps({
			currentModels: () =>
				new Map<string, string | null>([["geo-oliver", null]]),
			allowedTargets: () =>
				new Map<string, Array<string | null>>([
					["geo-oliver", ["claude-fable-5", "claude-opus-4-8[1m]", null]],
				]),
		});
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-oliver", toModel: "claude-opus-4-8[1m]" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(200);
		const req = r.body.canonicalRequest as CanonicalRequest;
		expect(req.changes[0]).toEqual({
			key: "geo-oliver",
			from: { model: null },
			to: { model: "claude-opus-4-8[1m]" },
		});
	});

	it("cross-origin → 403", () => {
		const r = handleStage(
			deps(),
			{ changes: [{ key: "geo-oliver", toModel: null }] },
			{ origin: "http://evil" },
			ORIGIN,
		);
		expect(r.status).toBe(403);
	});

	it("audit down → 503, no token", () => {
		const d = deps();
		d.audit.ok = false;
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-oliver", toModel: null }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(503);
	});

	it("model-authorization gate (HIGH-1): unauthorized model → 403", () => {
		const r = handleStage(
			deps(),
			{ changes: [{ key: "geo-oliver", toModel: "claude-evil-9" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(403);
	});

	it("model-authorization gate (HIGH-1): Codex Lead model change → 403", () => {
		const r = handleStage(
			deps(),
			{ changes: [{ key: "geo-mufasa", toModel: "gpt-9" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(403);
	});

	it("model-authorization gate (R3 HIGH-1): Codex explicit-model→null transition → 403", () => {
		// A Codex Lead carrying an explicit display-only model id must not be able
		// to transition to null even though [null].includes(null) is true.
		const d = deps({
			currentModels: () =>
				new Map<string, string | null>([["geo-mufasa", "gpt-5-display"]]),
			allowedTargets: () =>
				new Map<string, Array<string | null>>([["geo-mufasa", [null]]]),
		});
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-mufasa", toModel: null }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(403);
	});

	it("model-authorization gate (HIGH-1): non-string toModel → 400", () => {
		const r = handleStage(
			deps(),
			{
				changes: [
					{ key: "geo-oliver", toModel: { evil: 1 } as unknown as string },
				],
			},
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(400);
	});

	it("unknown key → 400", () => {
		const r = handleStage(
			deps(),
			{ changes: [{ key: "geo-ghost", toModel: null }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(400);
	});
});

describe("fleet-routes — handleStage effort (FLY-671)", () => {
	it("effort-only change: 200, canonical to.effort present, to.model = current", () => {
		const d = deps();
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-peter", toEffort: "high" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(200);
		const req = r.body.canonicalRequest as CanonicalRequest;
		// to.model filled from current; effort key present with the new value.
		expect(req.changes[0]).toEqual({
			key: "geo-peter",
			from: { model: "claude-fable-5", effort: null },
			to: { model: "claude-fable-5", effort: "high" },
		});
	});

	it("model+effort together: both dimensions in the canonical change", () => {
		const d = deps();
		const r = handleStage(
			d,
			{
				changes: [
					{ key: "geo-oliver", toModel: "claude-fable-5", toEffort: "medium" },
				],
			},
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(200);
		const req = r.body.canonicalRequest as CanonicalRequest;
		expect(req.changes[0]).toEqual({
			key: "geo-oliver",
			from: { model: null, effort: null },
			to: { model: "claude-fable-5", effort: "medium" },
		});
	});

	it("model-only change stays byte-identical (no effort key — reverse-compat)", () => {
		const d = deps();
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-oliver", toModel: "claude-fable-5" }] },
			SAME,
			ORIGIN,
		);
		const req = r.body.canonicalRequest as CanonicalRequest;
		expect(req.changes[0]).toEqual({
			key: "geo-oliver",
			from: { model: null },
			to: { model: "claude-fable-5" },
		});
	});

	it("Codex Lead non-null effort is rejected (display-only, 403)", () => {
		const d = deps();
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-mufasa", toEffort: "high" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(403);
		expect(String(r.body.error)).toMatch(/effort not allowed|display-only/);
	});

	it("effort outside the allowed set is rejected (forged client, 403)", () => {
		const d = deps();
		const r = handleStage(
			d,
			{ changes: [{ key: "geo-peter", toEffort: "ultra" }] },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(403);
	});
});

describe("fleet-routes — handleApply", () => {
	function stageThenBody(d: ReturnType<typeof deps>): ApplyBody {
		const s = handleStage(
			d,
			{ changes: [{ key: "geo-oliver", toModel: "claude-fable-5" }] },
			SAME,
			ORIGIN,
		);
		return {
			batch: s.body.canonicalRequest as CanonicalRequest,
			confirmToken: s.body.confirmToken as string,
		};
	}

	it("happy: valid token → 202 accepted, apply-requested audited", () => {
		const d = deps();
		const r = handleApply(d, stageThenBody(d), SAME, ORIGIN);
		expect(r.status).toBe(202);
		expect(r.body.accepted).toBe(true);
		expect(d.audit.rows.some((x) => x.event === "apply-requested")).toBe(true);
	});

	it("forged/expired token → 401 + denied audited (append-only)", () => {
		const d = deps();
		const body = stageThenBody(d);
		const r = handleApply(d, { ...body, confirmToken: "forged" }, SAME, ORIGIN);
		expect(r.status).toBe(401);
		expect(d.audit.rows.some((x) => x.event === "denied")).toBe(true);
	});

	it("replay (token reused) → 401", () => {
		const d = deps();
		const body = stageThenBody(d);
		expect(handleApply(d, body, SAME, ORIGIN).status).toBe(202);
		expect(handleApply(d, body, SAME, ORIGIN).status).toBe(401); // single-use
	});

	it("swapped transition (different SHA) → 401, no spawn", () => {
		const spawn = vi.fn(() => true);
		const d = deps({ spawnEngine: spawn });
		const body = stageThenBody(d);
		const tampered: CanonicalRequest = {
			...body.batch,
			changes: [
				{ key: "geo-oliver", from: { model: null }, to: { model: null } },
			],
		};
		const r = handleApply(
			d,
			{ batch: tampered, confirmToken: body.confirmToken },
			SAME,
			ORIGIN,
		);
		expect(r.status).toBe(401);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("launching create fails → 409 + apply-result rejected", () => {
		const d = deps({ createLaunching: () => false });
		const r = handleApply(d, stageThenBody(d), SAME, ORIGIN);
		expect(r.status).toBe(409);
		expect(
			d.audit.rows.some(
				(x) => x.event === "apply-result" && x.result === "rejected",
			),
		).toBe(true);
	});

	it("spawn fails → 500 + apply-result rejected (terminal)", () => {
		const d = deps({ spawnEngine: () => false });
		const r = handleApply(d, stageThenBody(d), SAME, ORIGIN);
		expect(r.status).toBe(500);
		expect(
			d.audit.rows.some(
				(x) => x.event === "apply-result" && x.result === "rejected",
			),
		).toBe(true);
	});

	it("apply-requested audit down → 503, no spawn", () => {
		const spawn = vi.fn(() => true);
		const d = deps({ spawnEngine: spawn });
		const body = stageThenBody(d);
		d.audit.ok = false; // now the apply-requested write fails
		const r = handleApply(d, body, SAME, ORIGIN);
		expect(r.status).toBe(503);
		expect(spawn).not.toHaveBeenCalled();
	});
});
