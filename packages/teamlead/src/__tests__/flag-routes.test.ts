import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import {
	type FlagCanonical,
	type FlagRouteDeps,
	type FlagStoreCanonical,
	flagCanonicalSha,
	handleFlagApply,
	handleFlagStage,
} from "../bridge/flag-routes.js";
import {
	initializeFlagStore,
	storeWorkflowTurnDivergenceAlertsEnabled,
} from "../bridge/flag-store-runtime.js";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { FleetAdminAudit } from "../bridge/fleet-admin-audit.js";
import { StateStore } from "../StateStore.js";

const ENV_CONTENT = "# env\nFLYWHEEL_OTHER=1\n";
const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function makeDeps(over: Partial<FlagRouteDeps> = {}): FlagRouteDeps & {
	env: Record<string, string | undefined>;
	writeFile: ReturnType<typeof vi.fn>;
	audit: FleetAdminAudit;
} {
	const dbPath = join(mkdtempSync(join(tmpdir(), "ffaudit-")), "audit.db");
	return {
		envPath: "/tmp/.env",
		readFile: () => ENV_CONTENT,
		writeFile: vi.fn(),
		env: {},
		lock: (fn: () => unknown) => fn(), // pass-through; real lock tested in flag-toggle
		tokens: new ConfirmTokenStore(),
		audit: new FleetAdminAudit(dbPath),
		...over,
	} as never;
}

async function makeManagedDeps(over: Partial<FlagRouteDeps> = {}) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const flagStore = initializeFlagStore(store, {}, 100);
	return { deps: makeDeps({ flagStore, ...over }), flagStore, store };
}

describe("handleFlagStage", () => {
	it("stages a direct flag: canonical + confirmToken + audit staged", () => {
		const deps = makeDeps();
		const r = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"http://localhost",
		);
		expect(r.code).toBe(200);
		const body = r.body as { canonical: FlagCanonical; confirmToken: string };
		expect(body.canonical.kind).toBe("flag");
		expect(body.canonical.envVar).toBe("FLYWHEEL_AUTO_QA");
		expect(body.canonical.rawTo).toBe("0"); // default_on off → write "0"
		expect(body.canonical.fileSha).toBe(computeEnvSha(ENV_CONTENT));
		expect(body.confirmToken).toBeTruthy();
	});

	it("rejects a non-direct / governance flag", () => {
		const deps = makeDeps();
		expect(
			handleFlagStage(
				deps,
				{ name: "voice_qa_presence_override", to: false },
				"o",
			).code,
		).toBe(400);
		expect(
			handleFlagStage(
				deps,
				{ name: "founder_consent_decision_mode", to: false },
				"o",
			).code,
		).toBe(400);
	});

	it("Codex R1 #2: rejects a malformed JSON boundary (non-boolean to / non-string name)", () => {
		const deps = makeDeps();
		// "off"/"false"/0 are truthy-or-not JS values that must NOT be coerced.
		for (const bad of ["off", "false", 0, 1, null, undefined]) {
			expect(
				handleFlagStage(
					deps,
					{ name: "auto_qa_killswitch", to: bad as never },
					"o",
				).code,
			).toBe(400);
		}
		expect(
			handleFlagStage(deps, { name: 123 as never, to: true }, "o").code,
		).toBe(400);
		expect(handleFlagStage(deps, {} as never, "o").code).toBe(400);
	});

	it("managed flag requires a reason and ignores a caller-supplied actor", async () => {
		const { deps } = await makeManagedDeps();
		expect(
			handleFlagStage(
				deps,
				{ name: "workflow_resume", to: true, reason: "   " },
				"o",
			).code,
		).toBe(400);

		const result = handleFlagStage(
			deps,
			{
				name: "workflow_resume",
				to: true,
				reason: "enable resumable runs",
				actor: "caller-claim",
			},
			"o",
		);
		expect(result.code).toBe(200);
		const body = result.body as {
			canonical: FlagStoreCanonical;
			confirmToken: string;
		};
		expect(body.canonical).toMatchObject({
			kind: "flag_store",
			name: "workflow_resume",
			rawFrom: null,
			rawTo: "1",
			revision: 1,
			effectiveFrom: false,
			effectiveTo: true,
			actor: "bridge-local-operator",
			reason: "enable resumable runs",
		});
		expect(body.confirmToken).toBeTruthy();
	});

	it("managed stage fails closed when its audit row cannot be written", async () => {
		const audit = { record: vi.fn(() => false) };
		const { deps } = await makeManagedDeps({ audit: audit as never });
		const result = handleFlagStage(
			deps,
			{ name: "workflow_resume", to: true, reason: "audit me" },
			"o",
		);
		expect(result).toEqual({
			code: 500,
			body: { error: "could not record staged flag change" },
		});
	});
});

describe("handleFlagApply", () => {
	it("applies with a valid token → mutates env, audits apply-result", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		const r = handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		expect(r.code).toBe(200);
		expect(deps.env.FLYWHEEL_AUTO_QA).toBe("0");
		expect(deps.writeFile).toHaveBeenCalledTimes(1);
	});

	it("replay with the same token → denied (single-use)", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		const replay = handleFlagApply(
			deps,
			staged.canonical,
			staged.confirmToken,
			"o",
		);
		expect(replay.code).toBe(401);
	});

	it("tampered canonical (SHA mismatch) → denied", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		const tampered = { ...staged.canonical, rawTo: null };
		const r = handleFlagApply(deps, tampered, staged.confirmToken, "o");
		expect(r.code).toBe(401);
	});

	// FLY-1356: enum managed flag (skill_framework_mode) — string target values.
	it("enum flag: stages a string target from enumValues; rawTo is always explicit", async () => {
		const { deps } = await makeManagedDeps();
		const r = handleFlagStage(
			deps,
			{ name: "skill_framework_mode", to: "split", reason: "trial split" },
			"o",
		);
		expect(r.code).toBe(200);
		const body = r.body as {
			canonical: FlagStoreCanonical;
			confirmToken: string;
		};
		expect(body.canonical.kind).toBe("flag_store");
		expect(body.canonical.rawTo).toBe("split");
		expect(body.canonical.effectiveFrom).toBe("superpowers");
		expect(body.canonical.effectiveTo).toBe("split");
	});

	it("enum flag: kill position (back to superpowers) stores the default EXPLICITLY", async () => {
		const { deps, store } = await makeManagedDeps();
		store.applyFlagValueChange({
			name: "skill_framework_mode",
			rawTo: "split",
			expectedRevision: 1,
			actor: "test",
			reason: "fixture",
			now: 200,
		});
		const staged = handleFlagStage(
			deps,
			{
				name: "skill_framework_mode",
				to: "superpowers",
				reason: "return to default",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(staged.canonical.rawTo).toBe("superpowers");
		expect(staged.canonical.effectiveFrom).toBe("split");
		const r = handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		expect(r.code).toBe(200);
		expect(store.getFlagValueRow("skill_framework_mode")?.raw).toBe(
			"superpowers",
		);
		expect(deps.writeFile).not.toHaveBeenCalled();
	});

	it("enum flag: target outside enumValues / boolean target → 400", async () => {
		const { deps } = await makeManagedDeps();
		const bad = handleFlagStage(
			deps,
			{ name: "skill_framework_mode", to: "garbage", reason: "test" },
			"o",
		);
		expect(bad.code).toBe(400);
		expect((bad.body as { allowed: string[] }).allowed).toContain("split");
		expect(
			handleFlagStage(
				deps,
				{
					name: "skill_framework_mode",
					to: true as never,
					reason: "test",
				},
				"o",
			).code,
		).toBe(400);
	});

	it("managed stage→apply changes the next read without env or file writes", async () => {
		const { deps, flagStore, store } = await makeManagedDeps();
		expect(storeWorkflowTurnDivergenceAlertsEnabled(flagStore)).toBe(false);
		const staged = handleFlagStage(
			deps,
			{
				name: "workflow_turn_divergence_alerts",
				to: true,
				reason: "live-read proof",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		const r = handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		expect(r.code).toBe(200);
		expect(storeWorkflowTurnDivergenceAlertsEnabled(flagStore)).toBe(true);
		expect(deps.env.FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS).toBeUndefined();
		expect(deps.writeFile).not.toHaveBeenCalled();
		expect(
			store.listFlagValueChanges("workflow_turn_divergence_alerts").at(-1),
		).toMatchObject({
			fromEffective: "false",
			toEffective: "true",
			changedBy: "bridge-local-operator",
			reason: "live-read proof",
		});
	});

	it("managed apply audit failure is pre-mutation; stale revisions are 409", async () => {
		const records: Array<Record<string, unknown>> = [];
		const audit = {
			record: vi.fn((row: Record<string, unknown>) => {
				records.push(row);
				return row.event !== "apply-requested";
			}),
		};
		const { deps, store } = await makeManagedDeps({ audit: audit as never });
		const staged = handleFlagStage(
			deps,
			{ name: "workflow_resume", to: true, reason: "audited" },
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o"),
		).toEqual({
			code: 500,
			body: { error: "could not record apply-requested flag change" },
		});
		expect(store.getFlagValueRow("workflow_resume")?.revision).toBe(1);

		const goodDeps = makeDeps({
			flagStore: deps.flagStore,
			audit: { record: vi.fn(() => true) } as never,
		});
		const stale = handleFlagStage(
			goodDeps,
			{ name: "workflow_resume", to: true, reason: "stale proof" },
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		store.applyFlagValueChange({
			name: "workflow_resume",
			rawTo: "1",
			expectedRevision: 1,
			actor: "other",
			reason: "race",
		});
		expect(
			handleFlagApply(goodDeps, stale.canonical, stale.confirmToken, "o").code,
		).toBe(409);
	});

	it("reports a warning when only the post-mutation apply-result audit fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const audit = {
			record: vi.fn(
				(row: Record<string, unknown>) => row.event !== "apply-result",
			),
		};
		const { deps, store } = await makeManagedDeps({ audit: audit as never });
		const staged = handleFlagStage(
			deps,
			{ name: "workflow_resume", to: true, reason: "post-audit proof" },
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o"),
		).toEqual({
			code: 200,
			body: { ok: true, warn: "apply-result audit write failed" },
		});
		expect(store.getFlagValueRow("workflow_resume")).toMatchObject({
			lastEffective: "true",
			revision: 2,
		});
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("apply-result audit write failed"),
		);
		warn.mockRestore();
	});

	it("refuses a legacy canonical forged for a store-managed identity", async () => {
		const { deps, store } = await makeManagedDeps();
		const canonical: FlagCanonical = {
			kind: "flag",
			batchId: "forged-managed-legacy",
			name: "workflow_resume",
			envVar: "FLYWHEEL_WORKFLOW_RESUME",
			rawFrom: null,
			rawTo: "1",
			fileSha: computeEnvSha(ENV_CONTENT),
			effectiveFrom: false,
			effectiveTo: true,
		};
		const token = deps.tokens.issue(flagCanonicalSha(canonical));
		expect(handleFlagApply(deps, canonical, token, "o").code).toBe(409);
		expect(store.getFlagValueRow("workflow_resume")?.revision).toBe(1);
		expect(deps.writeFile).not.toHaveBeenCalled();
	});

	it("managed routes are frozen during boot bypass", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const flagStore = initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" });
		const deps = makeDeps({ flagStore });
		expect(
			handleFlagStage(
				deps,
				{ name: "workflow_resume", to: true, reason: "must wait" },
				"o",
			).code,
		).toBe(409);
		const canonical: FlagStoreCanonical = {
			kind: "flag_store",
			batchId: "bypass-apply",
			name: "workflow_resume",
			rawFrom: null,
			rawTo: "1",
			revision: 1,
			effectiveFrom: false,
			effectiveTo: true,
			actor: "bridge-local-operator",
			reason: "must wait",
		};
		const token = deps.tokens.issue(flagCanonicalSha(canonical));
		expect(handleFlagApply(deps, canonical, token, "o").code).toBe(409);
	});

	it("flag canonical SHA is stable + change-sensitive", () => {
		const c: FlagCanonical = {
			kind: "flag",
			batchId: "b1",
			name: "x",
			envVar: "FLYWHEEL_X",
			rawFrom: null,
			rawTo: "0",
			fileSha: "sha",
			effectiveFrom: true,
			effectiveTo: false,
		};
		expect(flagCanonicalSha(c)).toBe(flagCanonicalSha({ ...c }));
		expect(flagCanonicalSha(c)).not.toBe(
			flagCanonicalSha({ ...c, rawTo: "1" }),
		);
	});
});
