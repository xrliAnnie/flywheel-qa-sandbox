/**
 * FLY-1234 (T4): routeSuspiciousReport structured-decision + cache-key seams.
 *
 * - onDecision fires EXACTLY ONCE on every terminal path (R3 #1): env off /
 *   no input / a_working / b_parked(±evidence) / c_stuck / suspicious /
 *   null verdict / routing throw.
 * - judgeCacheKey overrides the cooldown-cache key; default stays
 *   report.targetKey (suspicious pipeline byte-compat).
 * - buildJudgePrompt carries the FLY-1234 few-shot formations WITH the
 *   corroboration requirement.
 * - Judge interop: one instance, single-flight queue, distinct keys never
 *   share a cached verdict; same key serves the cache inside the cooldown.
 */

import { describe, expect, it, vi } from "vitest";
import type { SuspiciousReport } from "../detection-suspicious.js";
import {
	buildJudgePrompt,
	createWatchdogJudge,
	type JudgeDecision,
	routeSuspiciousReport,
	type SuspiciousJudgeRoutingDeps,
	type WatchdogJudgeVerdict,
} from "../watchdog-judge.js";

function report(over: Partial<SuspiciousReport> = {}): SuspiciousReport {
	return {
		targetKind: "runner",
		targetKey: "exec-1",
		reason: "heartbeat_quiet_confirm: uncertain",
		paneTail: "❯",
		episodeFingerprint: "fp-1",
		frames: [
			{ text: "frame\n❯", capturedAtMs: 0 },
			{ text: "frame\n❯", capturedAtMs: 240_000 },
		],
		...over,
	};
}

function verdict(v: WatchdogJudgeVerdict["verdict"]): WatchdogJudgeVerdict {
	return {
		verdict: v,
		attribution: "unknown",
		suggestedAction: "none",
		rationale: "because",
	};
}

function makeDeps(over: Partial<SuspiciousJudgeRoutingDeps> = {}) {
	const decisions: JudgeDecision[] = [];
	const delivered: SuspiciousReport[] = [];
	const deps: SuspiciousJudgeRoutingDeps = {
		judgeEnabled: () => true,
		judge: { judge: vi.fn(async () => verdict("a_working")) },
		deliver: (r) => {
			delivered.push(r);
		},
		auditSuppression: () => {},
		mechanicalParkEvidence: () => false,
		buildJudgeInput: (r) =>
			(r.frames?.length ?? 0) >= 2 ? { frames: r.frames as never } : null,
		onDecision: (d) => {
			decisions.push(d);
		},
		...over,
	};
	return { deps, decisions, delivered };
}

describe("routeSuspiciousReport onDecision (FLY-1234 R3 #1) — exactly once per terminal path", () => {
	it("env OFF → {delivered, unavailable}", async () => {
		const { deps, decisions } = makeDeps({ judgeEnabled: () => false });
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "unavailable" },
		]);
	});

	it("insufficient frames → {delivered, unavailable}", async () => {
		const { deps, decisions } = makeDeps();
		await routeSuspiciousReport(deps, report({ frames: undefined }));
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "unavailable" },
		]);
	});

	it("a_working → {suppressed, a_working}", async () => {
		const { deps, decisions, delivered } = makeDeps();
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "suppressed", decision: "a_working" },
		]);
		expect(delivered).toHaveLength(0);
	});

	it("b_parked WITH mechanical evidence → {suppressed, b_parked}", async () => {
		const { deps, decisions } = makeDeps({
			judge: { judge: vi.fn(async () => verdict("b_parked")) },
			mechanicalParkEvidence: () => true,
		});
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "suppressed", decision: "b_parked" },
		]);
	});

	it("b_parked WITHOUT evidence → {delivered, suspicious} (demoted, never silent)", async () => {
		const { deps, decisions, delivered } = makeDeps({
			judge: { judge: vi.fn(async () => verdict("b_parked")) },
		});
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "suspicious" },
		]);
		expect(delivered).toHaveLength(1);
	});

	it("c_stuck → {delivered, c_stuck}", async () => {
		const { deps, decisions } = makeDeps({
			judge: { judge: vi.fn(async () => verdict("c_stuck")) },
		});
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([{ outcome: "delivered", decision: "c_stuck" }]);
	});

	it("suspicious verdict → {delivered, suspicious}", async () => {
		const { deps, decisions } = makeDeps({
			judge: { judge: vi.fn(async () => verdict("suspicious")) },
		});
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "suspicious" },
		]);
	});

	it("null verdict (judge failed) → {delivered, unavailable}", async () => {
		const { deps, decisions } = makeDeps({
			judge: { judge: vi.fn(async () => null) },
		});
		await routeSuspiciousReport(deps, report());
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "unavailable" },
		]);
	});

	it("routing throw (fail-closed to delivery) → {delivered, unavailable}", async () => {
		const { deps, decisions, delivered } = makeDeps({
			buildJudgeInput: () => {
				throw new Error("input builder exploded");
			},
			logger: () => {},
		});
		await routeSuspiciousReport(deps, report());
		expect(delivered).toHaveLength(1);
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "unavailable" },
		]);
	});

	it("an onDecision sink that THROWS never breaks the routing result", async () => {
		const { deps, delivered } = makeDeps({
			onDecision: () => {
				throw new Error("sink bug");
			},
			judge: { judge: vi.fn(async () => verdict("c_stuck")) },
			logger: () => {},
		});
		const result = await routeSuspiciousReport(deps, report());
		expect(result).toBe("delivered");
		expect(delivered).toHaveLength(1);
	});

	it("byte-compat: no onDecision → identical legacy behavior", async () => {
		const { deps, delivered } = makeDeps({ onDecision: undefined });
		const result = await routeSuspiciousReport(deps, report());
		expect(result).toBe("suppressed");
		expect(delivered).toHaveLength(0);
	});

	it("a deliver sink that THROWS: exactly one delivery attempt, onDecision still fires once, no rejection (Codex R1 #1)", async () => {
		let deliverCalls = 0;
		const decisions: JudgeDecision[] = [];
		const { deps } = makeDeps({
			judgeEnabled: () => false,
			deliver: () => {
				deliverCalls += 1;
				throw new Error("sink failed");
			},
			onDecision: (d) => {
				decisions.push(d);
			},
			logger: () => {},
		});
		const result = await routeSuspiciousReport(deps, report());
		expect(result).toBe("delivered");
		expect(deliverCalls).toBe(1); // never re-delivered via the outer catch
		expect(decisions).toEqual([
			{ outcome: "delivered", decision: "unavailable" },
		]);
	});

	it("deliver throw on the c_stuck path: audit landed, one attempt, decision c_stuck", async () => {
		let deliverCalls = 0;
		const decisions: JudgeDecision[] = [];
		const audits: string[] = [];
		const { deps } = makeDeps({
			judge: { judge: vi.fn(async () => verdict("c_stuck")) },
			deliver: () => {
				deliverCalls += 1;
				throw new Error("sink failed");
			},
			auditSuppression: () => {},
			onDecision: (d) => {
				decisions.push(d);
			},
			logger: () => {},
		});
		deps.auditConfirmedStuck = () => {
			audits.push("confirmed");
		};
		const result = await routeSuspiciousReport(deps, report());
		expect(result).toBe("delivered");
		expect(deliverCalls).toBe(1);
		expect(audits).toEqual(["confirmed"]);
		expect(decisions).toEqual([{ outcome: "delivered", decision: "c_stuck" }]);
	});
});

describe("routeSuspiciousReport judgeCacheKey seam (FLY-1234 R2 #1)", () => {
	it("default (no judgeCacheKey) → judge keyed by report.targetKey", async () => {
		const judgeFn = vi.fn(async () => verdict("a_working"));
		const { deps } = makeDeps({ judge: { judge: judgeFn } });
		await routeSuspiciousReport(deps, report({ targetKey: "exec-legacy" }));
		expect(judgeFn).toHaveBeenCalledWith("exec-legacy", expect.anything());
	});

	it("judgeCacheKey injected → judge keyed by the derived key; report.targetKey untouched", async () => {
		const judgeFn = vi.fn(async () => verdict("a_working"));
		const seenReports: SuspiciousReport[] = [];
		const { deps } = makeDeps({
			judge: { judge: judgeFn },
			judgeCacheKey: (r, _input) => `derived-${r.targetKey}`,
			mechanicalParkEvidence: (r) => {
				seenReports.push(r);
				return false;
			},
		});
		const r = report({ targetKey: "exec-real" });
		await routeSuspiciousReport(deps, r);
		expect(judgeFn).toHaveBeenCalledWith(
			"derived-exec-real",
			expect.anything(),
		);
		// Everything except the cache key still sees the TRUE execId.
		expect(seenReports[0]!.targetKey).toBe("exec-real");
	});
});

describe("judge interop — one instance, keyed cache (FLY-1234 T4)", () => {
	function makeJudge() {
		const spawns: string[] = [];
		let now = 0;
		const judge = createWatchdogJudge({
			repoRoot: "/tmp",
			env: {},
			now: () => now,
			logger: () => {},
			spawnRunner: async (opts) => {
				spawns.push(opts.stdin);
				// REAL codex --json wire shape (FLY-1234 QA HIGH): the answer is an
				// escaped string inside item.completed.agent_message.text.
				const answer = JSON.stringify({
					verdict: "a_working",
					attribution: "unknown",
					suggestedAction: "n",
					rationale: "r",
				});
				const stdout = `${JSON.stringify({
					type: "item.completed",
					item: { id: "item_0", type: "agent_message", text: answer },
				})}\n{"type":"turn.completed","usage":{"input_tokens":1}}\n`;
				return { code: 0, stdout, timedOut: false };
			},
		});
		const advance = (ms: number): void => {
			now += ms;
		};
		return { judge, spawns, advance };
	}

	it("same key within cooldown → cached verdict (one spawn); different key → fresh judgment", async () => {
		const { judge, spawns } = makeJudge();
		const input = { frames: [{ text: "f", capturedAtMs: 0 }] };
		await judge.judge("key-A", input);
		await judge.judge("key-A", input); // cache hit
		expect(spawns).toHaveLength(1);
		await judge.judge("key-B", input); // different key → no cross-cache
		expect(spawns).toHaveLength(2);
	});
});

describe("buildJudgePrompt few-shot (FLY-1234 T4)", () => {
	const prompt = buildJudgePrompt({
		frames: [
			{ text: "one", capturedAtMs: 1 },
			{ text: "two", capturedAtMs: 2 },
		],
	});

	it("names the three healthy-but-quiet formations", () => {
		expect(prompt).toContain("Known healthy-but-quiet formations");
		expect(prompt).toContain("External code/design review wait");
		expect(prompt).toContain("Long thinking turn");
		expect(prompt).toContain("Test suite / long build");
	});

	it("demands corroboration — static pane text alone is never sufficient", () => {
		expect(prompt).toContain("static pane text ALONE is never sufficient");
		expect(prompt).toContain("No such corroboration → suspicious.");
		expect(prompt).toContain(
			"Stale-looking test output with no corroboration → suspicious.",
		);
	});
});
