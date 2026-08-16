import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_FLAGS, resolveFlag } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import {
	applyFlagToggle,
	type FlagToggleDeps,
	isDirectToggleable,
} from "../bridge/flag-toggle.js";
import {
	beginMailboxQueueDeployBarrier,
	defaultMailboxQueueBarrierMarkerPath,
	readMailboxQueueDeployBarrierMarker,
} from "../bridge/mailbox-queue-deploy-barrier.js";

const ENV_CONTENT = "# env\nFLYWHEEL_OTHER=1\n";
const SHA = computeEnvSha(ENV_CONTENT);

function deps(over: Partial<FlagToggleDeps> = {}): FlagToggleDeps & {
	env: Record<string, string | undefined>;
	writeFile: ReturnType<typeof vi.fn>;
} {
	return {
		envPath: "/tmp/.env",
		readFile: () => ENV_CONTENT,
		writeFile: vi.fn(),
		env: {},
		lock: (fn: () => unknown) => fn(), // pass-through; real lock tested separately
		...over,
	} as FlagToggleDeps & {
		env: Record<string, string | undefined>;
		writeFile: ReturnType<typeof vi.fn>;
	};
}

describe("isDirectToggleable", () => {
	it("true for a call-time env flag, false for governance / conversational", () => {
		const autoQa = FEATURE_FLAGS.find((f) => f.name === "auto_qa_killswitch");
		const gov = FEATURE_FLAGS.find(
			(f) => f.name === "founder_consent_decision_mode",
		);
		const restart = FEATURE_FLAGS.find((f) => f.name === "worktree_autoclean");
		expect(isDirectToggleable(autoQa as never)).toBe(true);
		expect(isDirectToggleable(gov as never)).toBe(false);
		expect(isDirectToggleable(restart as never)).toBe(false);
	});

	it("rejects non-boolean value flags even if later marked direct", () => {
		const autoQa = FEATURE_FLAGS.find((f) => f.name === "auto_qa_killswitch")!;
		expect(isDirectToggleable({ ...autoQa, valueKind: "value" } as never)).toBe(
			false,
		);
	});
});

describe("applyFlagToggle", () => {
	it("a successful apply heals a pre-existing live/file divergence", () => {
		const spec = FEATURE_FLAGS.find(
			(flag) => flag.name === "workflow_claims_read",
		)!;
		let file = "FLYWHEEL_WORKFLOW_CLAIMS_READ=0\n";
		const d = deps({
			env: { FLYWHEEL_WORKFLOW_CLAIMS_READ: "1" },
			readFile: () => file,
			writeFile: vi.fn((_path: string, content: string) => {
				file = content;
			}),
		});
		const before = resolveFlag(spec, {
			env: d.env,
			envFile: { status: "readable", content: file },
		});
		expect(before.divergence).toBe("split_brain");

		expect(
			applyFlagToggle(d, {
				name: spec.name,
				rawFrom: "1",
				rawTo: "0",
				fileSha: computeEnvSha(file),
			}),
		).toMatchObject({ ok: true });
		const after = resolveFlag(spec, {
			env: d.env,
			envFile: { status: "readable", content: file },
		});
		expect(after.divergence).toBeUndefined();
		expect(after.displayEffective).toBe(false);
	});

	it("happy path: turns a direct flag off — persists then mutates process.env", () => {
		const d = deps();
		const r = applyFlagToggle(d, {
			name: "auto_qa_killswitch",
			rawFrom: null, // was absent (default ON)
			rawTo: "0", // turn the kill-switch on (feature off)
			fileSha: SHA,
		});
		expect(r.ok).toBe(true);
		expect(r.code).toBe(0);
		expect(d.writeFile).toHaveBeenCalledTimes(1);
		expect(d.env.FLYWHEEL_AUTO_QA).toBe("0");
	});

	it("delete (rawTo null) removes the live key + persists", () => {
		const d = deps({ env: { FLYWHEEL_AUTO_QA: "0" } });
		const content = "FLYWHEEL_AUTO_QA=0\n";
		d.readFile = () => content;
		const r = applyFlagToggle(d, {
			name: "auto_qa_killswitch",
			rawFrom: "0",
			rawTo: null, // back to default (absent)
			fileSha: computeEnvSha(content),
		});
		expect(r.ok).toBe(true);
		expect("FLYWHEEL_AUTO_QA" in d.env).toBe(false);
	});

	it("rejects an unknown flag", () => {
		expect(
			applyFlagToggle(deps(), {
				name: "nope",
				rawFrom: null,
				rawTo: "0",
				fileSha: SHA,
			}).code,
		).toBe(400);
	});

	it("rejects a non-direct (restart) flag", () => {
		const r = applyFlagToggle(deps(), {
			name: "worktree_autoclean",
			rawFrom: null,
			rawTo: "0",
			fileSha: SHA,
		});
		expect(r.code).toBe(400);
		expect(r.reason).toMatch(/not direct-toggleable/);
	});

	it("rejects a governance gate", () => {
		const r = applyFlagToggle(deps(), {
			name: "founder_consent_decision_mode",
			rawFrom: null,
			rawTo: "enforce",
			fileSha: SHA,
		});
		expect(r.code).toBe(400);
	});

	it("denies when .env changed since review (fileSha mismatch)", () => {
		const r = applyFlagToggle(deps(), {
			name: "auto_qa_killswitch",
			rawFrom: null,
			rawTo: "0",
			fileSha: "stale-sha",
		});
		expect(r.code).toBe(409);
		expect(r.reason).toMatch(/changed since review/);
	});

	it("denies when the live value changed since review (rawFrom mismatch)", () => {
		const d = deps({ env: { FLYWHEEL_AUTO_QA: "0" } }); // live already 0
		const r = applyFlagToggle(d, {
			name: "auto_qa_killswitch",
			rawFrom: null, // reviewed as absent, but live is "0"
			rawTo: "1",
			fileSha: SHA,
		});
		expect(r.code).toBe(409);
		expect(d.writeFile).not.toHaveBeenCalled();
	});

	it("persist failure → code 500, NO live change", () => {
		const d = deps();
		d.writeFile = vi.fn(() => {
			throw new Error("disk full");
		});
		const r = applyFlagToggle(d, {
			name: "auto_qa_killswitch",
			rawFrom: null,
			rawTo: "0",
			fileSha: SHA,
		});
		expect(r.code).toBe(500);
		expect("FLYWHEEL_AUTO_QA" in d.env).toBe(false); // live untouched
	});
});

// Codex R1 #1: the transaction guarantee under the REAL cross-process file lock
// (plan §4.3) + real fs. Two direct flags staged from the same baseline: after
// the first applies, the second — still carrying the old SHA — must fail closed
// (409) and NOT clobber the first. Uses the default lock + writer (no injection).
describe("applyFlagToggle — real .env lock + interleaving", () => {
	function twoDirectFlags() {
		const directs = FEATURE_FLAGS.filter(
			(f) => f.toggleable === "direct" && f.envVar,
		);
		if (directs.length < 2)
			throw new Error("need ≥2 direct flags for the test");
		return [directs[0], directs[1]] as const;
	}
	const rawOff = (polarity: string) => (polarity === "default_on" ? "0" : "1");

	it("second toggle from a stale baseline fails closed (no clobber) + lock cleaned", () => {
		const dir = mkdtempSync(join(tmpdir(), "ff-lock-"));
		const envPath = join(dir, ".env");
		const initial = "# env\nFLYWHEEL_OTHER=1\n";
		writeFileSync(envPath, initial);
		const baselineSha = computeEnvSha(initial);
		const [flagA, flagB] = twoDirectFlags();
		const env: Record<string, string | undefined> = {};
		const realDeps = {
			envPath,
			readFile: (p: string) => readFileSync(p, "utf-8"),
			env,
		};

		// apply A from the baseline — real lock + real atomic writer.
		const a = applyFlagToggle(realDeps, {
			name: flagA.name,
			rawFrom: null,
			rawTo: rawOff(flagA.polarity),
			fileSha: baselineSha,
		});
		expect(a.ok).toBe(true);
		expect(existsSync(`${envPath}.lock`)).toBe(false); // lock released

		// apply B still carries the OLD baseline SHA → the re-read under the lock
		// sees the changed file → 409, no write.
		const b = applyFlagToggle(realDeps, {
			name: flagB.name,
			rawFrom: null,
			rawTo: rawOff(flagB.polarity),
			fileSha: baselineSha,
		});
		expect(b.code).toBe(409);

		// A's change survived; B never wrote.
		const finalContent = readFileSync(envPath, "utf-8");
		expect(finalContent).toContain(`${flagA.envVar}=`);
		expect(finalContent).not.toContain(`${flagB.envVar}=`);
		expect(existsSync(`${envPath}.lock`)).toBe(false);
	});

	it("an operator mailbox OFF no-op invalidates deploy ownership under that same lock", () => {
		const dir = mkdtempSync(join(tmpdir(), "ff-mailbox-barrier-lock-"));
		const envPath = join(dir, ".env");
		writeFileSync(envPath, "OTHER=1\n");
		const env: Record<string, string | undefined> = {};
		const begin = beginMailboxQueueDeployBarrier(
			{ envPath, env, newToken: () => "deploy-owner" },
			"a".repeat(40),
		);
		expect(begin).toMatchObject({ ok: true, owned: true });
		const offBytes = readFileSync(envPath, "utf8");

		const result = applyFlagToggle(
			{
				envPath,
				readFile: (p: string) => readFileSync(p, "utf8"),
				env,
				mailboxQueueBarrierNewToken: () => "operator-owner",
			},
			{
				name: "mailbox_queue",
				rawFrom: "0",
				rawTo: "0",
				fileSha: computeEnvSha(offBytes),
			},
		);

		expect(result).toMatchObject({ ok: true });
		expect(readFileSync(envPath, "utf8")).toBe(offBytes);
		expect(
			readMailboxQueueDeployBarrierMarker(
				defaultMailboxQueueBarrierMarkerPath(envPath),
			),
		).toMatchObject({
			phase: "operator_override",
			ownershipToken: "operator-owner",
		});
	});
});
