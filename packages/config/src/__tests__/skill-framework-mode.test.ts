import { describe, expect, it, vi } from "vitest";
import {
	BACKEND_SKILL_ASSEMBLY,
	defaultAgentsSkillsDir,
	hashModeBucket,
	MATT_SKILLS_PLUGIN_KEY,
	resolveSkillFrameworkMode,
	SKILL_FRAMEWORK_MODE_ENV,
	SKILL_FRAMEWORK_MODES,
	SUPERPOWERS_CODEX_NAMESPACE,
	SUPERPOWERS_PLUGIN_KEY,
	skillAssemblyBaseArm,
} from "../skill-framework-mode.js";
import { EXECUTOR_BACKENDS } from "../types.js";

// FLY-1356 — single-truth resolver for the three-way skill-framework switch.
// Semantics under test = plan §0 mode table, row by row. The resolver is a
// TOTAL function (Bar-Raiser R1#1): every input combination returns {mode, via},
// it never throws — a kill (env flipped off `split`) must not break an in-flight
// successor pipeline that still carries an old override.

const ID = "FLY-1356";

function envWith(value?: string): Record<string, string | undefined> {
	return value === undefined ? {} : { [SKILL_FRAMEWORK_MODE_ENV]: value };
}

describe("constants", () => {
	it("exposes the four experiment arms in fixed bucket order", () => {
		expect(SKILL_FRAMEWORK_MODES).toEqual([
			"superpowers",
			"matt",
			"bare",
			"bare-ponytail",
		]);
		expect(skillAssemblyBaseArm("bare-ponytail")).toBe("bare");
		expect(skillAssemblyBaseArm("superpowers")).toBe("superpowers");
		expect(skillAssemblyBaseArm("matt")).toBe("matt");
		expect(skillAssemblyBaseArm("bare")).toBe("bare");
	});
	it("plugin keys match the real-machine spike values (research.md S2)", () => {
		expect(SUPERPOWERS_PLUGIN_KEY).toBe("superpowers@superpowers-dev");
		expect(MATT_SKILLS_PLUGIN_KEY).toBe("matt-skills@matt-skills");
	});
	it("declares assembly capability for every executor backend", () => {
		expect(Object.keys(BACKEND_SKILL_ASSEMBLY).sort()).toEqual(
			[...EXECUTOR_BACKENDS].sort(),
		);
		expect(BACKEND_SKILL_ASSEMBLY).toEqual({
			"claude-tmux": "native",
			"codex-tmux": "native",
			"antigravity-tmux": "none",
			"kimi-tmux": "none",
		});
	});
	it("exposes the Codex superpowers namespace and injectable agents-skills root", () => {
		expect(SUPERPOWERS_CODEX_NAMESPACE).toBe("superpowers");
		expect(defaultAgentsSkillsDir("/tmp/fly1395-home")).toBe(
			"/tmp/fly1395-home/.agents/skills",
		);
	});
});

describe("resolveSkillFrameworkMode — §0 priority table", () => {
	it("env unset → superpowers via default", () => {
		expect(
			resolveSkillFrameworkMode({ env: envWith(), issueIdentifier: ID }),
		).toEqual({ mode: "superpowers", via: "default" });
	});

	it("env forced to each of the three modes → that value via forced", () => {
		for (const mode of SKILL_FRAMEWORK_MODES) {
			expect(
				resolveSkillFrameworkMode({ env: envWith(mode), issueIdentifier: ID }),
			).toEqual({ mode, via: "forced" });
		}
	});

	it("env≠split + stale override → override IGNORED, resolved by flag, via forced, never throws (R1#1)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// kill scenario: flag set back to superpowers while a successor still
			// carries override "bare" — the pipeline must proceed as A.
			expect(
				resolveSkillFrameworkMode({
					env: envWith("superpowers"),
					issueIdentifier: ID,
					override: "bare",
				}),
			).toEqual({ mode: "superpowers", via: "forced" });
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("env unset + stale override → override ignored, default (total function)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				resolveSkillFrameworkMode({
					env: envWith(),
					issueIdentifier: ID,
					override: "matt",
				}),
			).toEqual({ mode: "superpowers", via: "default" });
		} finally {
			warn.mockRestore();
		}
	});

	it("split + project opt-out → superpowers via project_opt_out (beats override/stamp)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				override: "bare",
				priorStamp: "matt",
				projectSplitParticipation: false,
			}),
		).toEqual({ mode: "superpowers", via: "project_opt_out" });
	});

	it("split + per-dispatch override → override (beats stamp/hash)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				override: "bare",
				priorStamp: "matt",
			}),
		).toEqual({ mode: "bare", via: "override" });
	});

	it("split + prior stamp → sticky (beats hash) (R1#4)", () => {
		const hashed = hashModeBucket(ID);
		const stamp = SKILL_FRAMEWORK_MODES.find((m) => m !== hashed);
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				priorStamp: stamp,
			}),
		).toEqual({ mode: stamp, via: "sticky" });
	});

	it.each([
		["override", { override: "bare-ponytail" }, "override"],
		["prior stamp", { priorStamp: "bare-ponytail" }, "sticky"],
	] as const)(
		"split + D-arm %s carrier preserves D attribution",
		(_name, carrier, via) => {
			expect(
				resolveSkillFrameworkMode({
					env: envWith("split"),
					issueIdentifier: ID,
					...carrier,
				}),
			).toEqual({ mode: "bare-ponytail", via });
		},
	);

	it("split first admission → hash bucket", () => {
		expect(
			resolveSkillFrameworkMode({ env: envWith("split"), issueIdentifier: ID }),
		).toEqual({ mode: hashModeBucket(ID), via: "hash" });
	});

	it("split + participation explicitly true → normal split path", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				projectSplitParticipation: true,
			}),
		).toEqual({ mode: hashModeBucket(ID), via: "hash" });
	});

	it("invalid env value → superpowers via default (fail-closed) + warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				resolveSkillFrameworkMode({
					env: envWith("SPLIT-nonsense"),
					issueIdentifier: ID,
				}),
			).toEqual({ mode: "superpowers", via: "default" });
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("garbage override / priorStamp values are ignored, never thrown on", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				resolveSkillFrameworkMode({
					env: envWith("split"),
					issueIdentifier: ID,
					// simulate corrupted DB / boundary bypass values
					override: "garbage" as never,
					priorStamp: "junk" as never,
				}),
			).toEqual({ mode: hashModeBucket(ID), via: "hash" });
		} finally {
			warn.mockRestore();
		}
	});
});

// FLY-1356 fix round 2 (Codex R1 HIGH-2): a FAILED sticky-stamp read must
// fail closed to A — never fall through to the hash bucket. The issue may
// already be stamped in another arm (hashing could split it), and an
// infrastructure fault must never push an issue INTO an experimental arm.
// ID hashes to "bare" (asserted below), so every fail-closed expectation
// here is a REAL difference from the hash outcome — removing the resolver's
// readFailed branch turns these red as {mode:"bare", via:"hash"}.
describe("resolveSkillFrameworkMode — priorStampReadFailed", () => {
	it("precondition: the test identifier's hash bucket is NOT superpowers", () => {
		expect(hashModeBucket(ID)).toBe("bare");
	});

	it("split + readFailed → superpowers via fallback_superpowers (never the hash)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				resolveSkillFrameworkMode({
					env: envWith("split"),
					issueIdentifier: ID,
					priorStampReadFailed: true,
				}),
			).toEqual({ mode: "superpowers", via: "fallback_superpowers" });
		} finally {
			warn.mockRestore();
		}
	});

	it("a successfully read stamp is authoritative over readFailed (sticky wins)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				priorStamp: "matt",
				priorStampReadFailed: true,
			}),
		).toEqual({ mode: "matt", via: "sticky" });
	});

	it("override still wins under readFailed (deterministic carrier, no DB read)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("split"),
				issueIdentifier: ID,
				override: "matt",
				priorStampReadFailed: true,
			}),
		).toEqual({ mode: "matt", via: "override" });
	});

	it("forced env ignores readFailed (kill-switch semantics)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith("matt"),
				issueIdentifier: ID,
				priorStampReadFailed: true,
			}),
		).toEqual({ mode: "matt", via: "forced" });
	});

	it("default env ignores readFailed (byte-compat)", () => {
		expect(
			resolveSkillFrameworkMode({
				env: envWith(),
				issueIdentifier: ID,
				priorStampReadFailed: true,
			}),
		).toEqual({ mode: "superpowers", via: "default" });
	});
});

describe("hashModeBucket", () => {
	it("is deterministic for a fixed identifier", () => {
		const first = hashModeBucket(ID);
		for (let i = 0; i < 5; i++) expect(hashModeBucket(ID)).toBe(first);
	});

	it("bucket membership is always one of the four modes", () => {
		for (const id of ["FLY-1", "GEO-100", "", "abc", "FLY-1356"]) {
			expect(SKILL_FRAMEWORK_MODES).toContain(hashModeBucket(id));
		}
	});

	it("distributes ~evenly over 10,000 identifiers across exactly four buckets", () => {
		const counts: Record<string, number> = {
			superpowers: 0,
			matt: 0,
			bare: 0,
			"bare-ponytail": 0,
		};
		const N = 10_000;
		for (let i = 0; i < N; i++) counts[hashModeBucket(`FLY-${i}`)]++;
		expect(
			Object.entries(counts).filter(([, count]) => count > 0),
		).toHaveLength(4);
		for (const mode of SKILL_FRAMEWORK_MODES) {
			expect(counts[mode] / N).toBeGreaterThanOrEqual(0.215);
			expect(counts[mode] / N).toBeLessThanOrEqual(0.285);
		}
	});
});
