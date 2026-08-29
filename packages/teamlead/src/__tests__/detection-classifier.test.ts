/**
 * FLY-871 R2 — layered detector (47cff318①): pattern primary, AI fallback for
 * unrecognised-anomalous text, fail-suspicious for the rest. Never silent-healthy.
 */

import { describe, expect, it, vi } from "vitest";
import {
	classifyDetection,
	type DetectionCategory,
	makeSubscriptionDetectionClassifier,
} from "../account-heal/detection-classifier.js";
import type { RunnerResult } from "../bridge/approval-signal/subscription-claude-classifier-runner.js";

describe("classifyDetection — Layer 1 fixed pattern", () => {
	it("login_expired: classic + runner kicked-out variants", async () => {
		for (const t of [
			"Your login has expired, please re-authenticate",
			"Invalid API key · Please run /login",
			"Session expired. Run /login to continue.",
			"You are not logged in",
			"Authentication failed",
		]) {
			const r = await classifyDetection(t);
			expect(r.category).toBe("login_expired");
			expect(r.layer).toBe("pattern");
			expect(r.confidence).toBe("high");
		}
	});

	it("usage_limit / rate_limit / permission_blocked", async () => {
		expect(
			(await classifyDetection("You've hit your usage limit")).category,
		).toBe("usage_limit");
		expect((await classifyDetection("429 rate limit exceeded")).category).toBe(
			"rate_limit",
		);
		expect(
			(await classifyDetection("permission required to write file")).category,
		).toBe("permission_blocked");
	});

	it("FLY-218: 'not your usage limit' is NOT a usage cap", async () => {
		const r = await classifyDetection(
			"Server is temporarily limiting requests (not your usage limit)",
		);
		expect(r.category).not.toBe("usage_limit");
	});

	it("healthy: a normal pane with no error signal → healthy (no model call)", async () => {
		const ai = vi.fn();
		const r = await classifyDetection(
			"⏵⏵ bypass permissions · Writing tests · ctx 42%",
			{ aiClassify: ai },
		);
		expect(r.category).toBe("healthy");
		expect(r.layer).toBe("pattern");
		expect(ai).not.toHaveBeenCalled(); // cost-saving: healthy short-circuits
	});
});

describe("classifyDetection — Layer 2 AI fallback (unrecognised + anomalous)", () => {
	const ANOMALOUS =
		"Something went wrong: unexpected error talking to the server";

	it("AI resolves an unrecognised-anomalous pane to a category", async () => {
		const ai = vi.fn(async () => "login_expired" as DetectionCategory);
		const r = await classifyDetection(ANOMALOUS, { aiClassify: ai });
		expect(ai).toHaveBeenCalledOnce();
		expect(r.category).toBe("login_expired");
		expect(r.layer).toBe("ai");
		expect(r.confidence).toBe("low");
	});

	it("AI can classify it as healthy (overriding the anomaly heuristic)", async () => {
		const r = await classifyDetection(ANOMALOUS, {
			aiClassify: async () => "healthy",
		});
		expect(r.category).toBe("healthy");
		expect(r.layer).toBe("ai");
	});
});

describe("classifyDetection — Layer 3 fail-suspicious (never silent-healthy)", () => {
	const ANOMALOUS =
		"Something went wrong: unexpected error talking to the server";

	it("AI returns null (unknown) → suspicious", async () => {
		const r = await classifyDetection(ANOMALOUS, {
			aiClassify: async () => null,
		});
		expect(r.category).toBe("suspicious");
		expect(r.layer).toBe("suspicious");
	});

	it("no AI classifier wired → anomalous text is suspicious, not healthy", async () => {
		const r = await classifyDetection(ANOMALOUS);
		expect(r.category).toBe("suspicious");
	});

	it("AI throws → fail-closed → suspicious", async () => {
		const r = await classifyDetection(ANOMALOUS, {
			aiClassify: async () => {
				throw new Error("boom");
			},
		});
		expect(r.category).toBe("suspicious");
	});
});

describe("makeSubscriptionDetectionClassifier — verdict mapping (fail-closed)", () => {
	function withRunner(res: RunnerResult | (() => never)) {
		return makeSubscriptionDetectionClassifier({
			runnerImpl: async () => {
				if (typeof res === "function") return res();
				return res;
			},
		});
	}

	it("maps a known category verdict", async () => {
		const ai = withRunner({ ok: true, verdict: { category: "login_expired" } });
		expect(await ai("whatever")).toBe("login_expired");
	});

	it("'unknown' category → null", async () => {
		const ai = withRunner({ ok: true, verdict: { category: "unknown" } });
		expect(await ai("whatever")).toBeNull();
	});

	it("runner failure → null", async () => {
		const ai = withRunner({ ok: false, reason: "exec_failed" });
		expect(await ai("whatever")).toBeNull();
	});

	it("malformed verdict → null", async () => {
		expect(await withRunner({ ok: true, verdict: "nope" })("x")).toBeNull();
		expect(await withRunner({ ok: true, verdict: null })("x")).toBeNull();
		expect(
			await withRunner({ ok: true, verdict: { category: 42 } })("x"),
		).toBeNull();
	});

	it("runner throwing → null (belt-and-suspenders)", async () => {
		const ai = withRunner(() => {
			throw new Error("boom");
		});
		expect(await ai("whatever")).toBeNull();
	});
});
