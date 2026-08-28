import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FEATURE_FLAGS,
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
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
import * as FlagStoreReaders from "../bridge/flag-store-runtime.js";
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
		projectNames: () => ["flywheel", "geoforge3d"],
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
	it("rejects a bridge-global project row before toggleability checks", async () => {
		const { deps } = await makeManagedDeps();
		const result = handleFlagStage(
			deps,
			{
				name: "mailbox_queue",
				to: true,
				project: "flywheel",
				reason: "must not create a project row",
			},
			"o",
		);
		expect(result.code).toBe(400);
		expect(result.body).toMatchObject({
			error: expect.stringMatching(/bridge_global.*project/i),
		});
	});

	it("validates project-store scope against the configured roster", async () => {
		const { deps } = await makeManagedDeps();
		const result = handleFlagStage(
			deps,
			{
				name: "doc_flow",
				to: true,
				project: "not-on-roster",
				reason: "must fail",
			},
			"o",
		);
		expect(result.code).toBe(400);
		expect(result.body).toMatchObject({
			error: "unknown project scope: not-on-roster",
			allowed: ["*", "flywheel", "geoforge3d"],
		});
	});

	it.each(["checkpoint_enabled", "ponytail", "xiaohongshu_auto_create"])(
		"does not expose the DB writer for unsafe project flag %s",
		async (name) => {
			const { deps } = await makeManagedDeps();
			const result = handleFlagStage(
				deps,
				{
					name,
					to: true,
					project: "flywheel",
					reason: "must stay in its existing owner",
				},
				"o",
			);
			expect(result.code).toBe(400);
			expect(result.body).toMatchObject({
				error: `${name} is not project-store-managed`,
			});
		},
	);

	it("stages a direct flag: canonical + confirmToken + audit staged", () => {
		const deps = makeDeps();
		const r = handleFlagStage(
			deps,
			{ name: "founder_review_orphan_monitor", to: false },
			"http://localhost",
		);
		expect(r.code).toBe(200);
		const body = r.body as { canonical: FlagCanonical; confirmToken: string };
		expect(body.canonical.kind).toBe("flag");
		expect(body.canonical.envVar).toBe(
			"FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR",
		);
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
			handleFlagStage(deps, { name: "lead_lease_bypass", to: false }, "o").code,
		).toBe(400);
	});

	it("Codex R1 #2: rejects a malformed JSON boundary (non-boolean to / non-string name)", () => {
		const deps = makeDeps();
		// "off"/"false"/0 are truthy-or-not JS values that must NOT be coerced.
		for (const bad of ["off", "false", 0, 1, null, undefined]) {
			expect(
				handleFlagStage(
					deps,
					{ name: "founder_review_orphan_monitor", to: bad as never },
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
				{
					name: "workflow_turn_divergence_alerts",
					to: true,
					reason: "   ",
				},
				"o",
			).code,
		).toBe(400);

		const result = handleFlagStage(
			deps,
			{
				name: "workflow_turn_divergence_alerts",
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
			name: "workflow_turn_divergence_alerts",
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
			{
				name: "workflow_turn_divergence_alerts",
				to: true,
				reason: "audit me",
			},
			"o",
		);
		expect(result).toEqual({
			code: 500,
			body: { error: "could not record staged flag change" },
		});
	});
});

describe("handleFlagApply", () => {
	it("sets project and star rows through one scoped stage/apply path", async () => {
		const { deps, store } = await makeManagedDeps();
		for (const [project, to] of [
			["*", false],
			["flywheel", true],
		] as const) {
			const staged = handleFlagStage(
				deps,
				{
					name: "doc_flow",
					to,
					project,
					op: "set",
					reason: `doc_flow ${project}`,
				},
				"o",
			);
			expect(staged.code).toBe(200);
			const body = staged.body as {
				canonical: FlagStoreCanonical;
				confirmToken: string;
			};
			expect(body.canonical).toMatchObject({
				kind: "flag_store",
				name: "doc_flow",
				scope: project,
				op: "set",
				rawTo: to ? "1" : "0",
				expectedChangeSeq: 0,
				effectiveTo: to,
			});
			expect(
				handleFlagApply(deps, body.canonical, body.confirmToken, "o").code,
			).toBe(200);
		}
		expect(store.getFlagValueRow("doc_flow", "*")).toMatchObject({
			raw: "0",
			lastEffective: "false",
		});
		expect(store.getFlagValueRow("doc_flow", "flywheel")).toMatchObject({
			raw: "1",
			lastEffective: "true",
		});
	});

	it("clears a project row to inheritance and keeps the scoped audit", async () => {
		const { deps, store } = await makeManagedDeps();
		const seeded = store.applyScopedFlagValueChange({
			name: "doc_flow",
			scope: "flywheel",
			op: "set",
			rawTo: "1",
			expectedChangeSeq: 0,
			actor: "fixture",
			reason: "fixture",
		});
		expect(seeded).toMatchObject({ ok: true });
		const staged = handleFlagStage(
			deps,
			{
				name: "doc_flow",
				project: "flywheel",
				op: "clear",
				reason: "inherit from star",
			} as never,
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(staged.canonical).toMatchObject({
			scope: "flywheel",
			op: "clear",
			rawTo: null,
			effectiveTo: "inherit",
		});
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o").code,
		).toBe(200);
		expect(store.getFlagValueRow("doc_flow", "flywheel")).toBeUndefined();
		expect(
			store.listFlagValueChanges("doc_flow", "flywheel").at(-1),
		).toMatchObject({
			action: "clear",
			toEffective: "inherit",
		});
	});

	it("clears a global store override without deleting its star row", async () => {
		const { deps, store } = await makeManagedDeps();
		store.applyFlagValueChange({
			name: "workflow_turn_divergence_alerts",
			rawTo: "1",
			expectedRevision: 1,
			actor: "fixture",
			reason: "fixture",
		});
		const staged = handleFlagStage(
			deps,
			{
				name: "workflow_turn_divergence_alerts",
				project: "*",
				op: "clear",
				reason: "return to default",
			} as never,
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o").code,
		).toBe(200);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
			hasOverride: false,
			raw: null,
			revision: 3,
		});
	});

	it("rejects clear for a non-store global flag", () => {
		const result = handleFlagStage(
			makeDeps(),
			{
				name: "founder_review_orphan_monitor",
				project: "*",
				op: "clear",
				reason: "unsupported",
			} as never,
			"o",
		);
		expect(result.code).toBe(400);
		expect(result.body).toMatchObject({
			error: expect.stringMatching(/clear.*store-managed/i),
		});
	});

	it("rejects a scoped apply after a third-party write advances the audit fence", async () => {
		const { deps, store } = await makeManagedDeps();
		const staged = handleFlagStage(
			deps,
			{
				name: "doc_flow",
				to: true,
				project: "flywheel",
				reason: "reviewed value",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		store.applyScopedFlagValueChange({
			name: "doc_flow",
			scope: "flywheel",
			op: "set",
			rawTo: "0",
			expectedChangeSeq: 0,
			actor: "other",
			reason: "race",
		});
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o").code,
		).toBe(409);
	});

	it("revalidates the project roster when a staged write is applied", async () => {
		let projects = ["flywheel"];
		const { deps, store } = await makeManagedDeps({
			projectNames: () => projects,
		});
		const staged = handleFlagStage(
			deps,
			{
				name: "doc_flow",
				to: true,
				project: "flywheel",
				reason: "roster race proof",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		projects = [];
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o"),
		).toMatchObject({ code: 400 });
		expect(store.getFlagValueRow("doc_flow", "flywheel")).toBeUndefined();
	});

	it("applies with a valid token → mutates env, audits apply-result", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "founder_review_orphan_monitor", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		const r = handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		expect(r.code).toBe(200);
		expect(deps.env.FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR).toBe("0");
		expect(deps.writeFile).toHaveBeenCalledTimes(1);
	});

	it("replay with the same token → denied (single-use)", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "founder_review_orphan_monitor", to: false },
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
			{ name: "founder_review_orphan_monitor", to: false },
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

	it("round-trips every store-managed state through its declared runtime reader", async () => {
		const { deps, flagStore, store } = await makeManagedDeps();
		expect(STORE_MANAGED_FLAGS.size).toBeGreaterThan(0);

		for (const name of STORE_MANAGED_FLAGS) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			const codec = getFlagStoreCodec(name);
			expect(spec, name).toBeDefined();
			expect(codec, name).toBeDefined();
			if (!spec || !codec) continue;
			const resolverSymbols = [
				...new Set(spec.readSites.map((site) => site.resolverSymbol)),
			];
			expect(resolverSymbols, name).toHaveLength(1);
			const reader = Reflect.get(FlagStoreReaders, resolverSymbols[0] ?? "") as
				| ((runtime: typeof flagStore) => unknown)
				| undefined;
			expect(reader, `${name} runtime reader`).toBeTypeOf("function");
			if (!reader) continue;

			const applyTarget = (target: boolean | string): void => {
				const reason = `exercise management route for ${name} => ${String(target)}`;
				const before = store.getFlagValueRow(name);
				expect(before, name).toBeDefined();
				if (!before) return;
				const effectiveFrom = codec.parse({
					hasOverride: before.raw !== null,
					raw: before.raw,
				});
				const expectedRaw =
					spec.valueKind === "enum"
						? String(target)
						: target === spec.default
							? null
							: target
								? "1"
								: "0";
				const staged = handleFlagStage(deps, { name, to: target, reason }, "o");
				expect(staged.code, `${name}:${String(target)}`).toBe(200);
				const body = staged.body as {
					canonical: FlagStoreCanonical;
					confirmToken: string;
				};
				expect(body.canonical, name).toMatchObject({
					kind: "flag_store",
					name,
					revision: before.revision,
					rawTo: expectedRaw,
					effectiveFrom,
					effectiveTo: target,
					actor: "bridge-local-operator",
					reason,
				});
				expect(
					handleFlagApply(deps, body.canonical, body.confirmToken, "o").code,
					name,
				).toBe(200);
				expect(store.getFlagValueRow(name), name).toMatchObject({
					revision: before.revision + 1,
					raw: expectedRaw,
					lastEffective: String(target),
				});
				expect(store.listFlagValueChanges(name).at(-1), name).toMatchObject({
					action: expectedRaw === null ? "clear" : "set",
					changedBy: "bridge-local-operator",
					reason,
				});
				const runtimeValue = reader(flagStore);
				if (spec.valueKind === "bool") {
					expect(runtimeValue, `${name} runtime effective`).toBe(target);
				} else {
					expect(runtimeValue, `${name} runtime raw`).toMatchObject({
						hasOverride: true,
						raw: target,
					});
				}
			};

			if (spec.valueKind === "bool") {
				applyTarget(!spec.default);
				applyTarget(spec.default);
			} else if (spec.valueKind === "enum") {
				for (const member of spec.enumValues ?? []) applyTarget(member);
				applyTarget(spec.default);
				const current = store.getFlagValueRow(name);
				expect(current, name).toBeDefined();
				if (!current) continue;
				expect(
					store.applyFlagValueChange({
						name,
						rawTo: "__unsupported__",
						expectedRevision: current.revision,
						actor: "test",
						reason: "invalid enum fallback proof",
					}),
				).toMatchObject({ ok: true });
				const runtimeValue = reader(flagStore);
				expect(runtimeValue).toMatchObject({ raw: "__unsupported__" });
				expect(codec.parse(runtimeValue as never), name).toBe(spec.default);
			}
		}

		expect(deps.writeFile).not.toHaveBeenCalled();
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
			{
				name: "workflow_turn_divergence_alerts",
				to: true,
				reason: "audited",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o"),
		).toEqual({
			code: 500,
			body: { error: "could not record apply-requested flag change" },
		});
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts")?.revision,
		).toBe(1);

		const goodDeps = makeDeps({
			flagStore: deps.flagStore,
			audit: { record: vi.fn(() => true) } as never,
		});
		const stale = handleFlagStage(
			goodDeps,
			{
				name: "workflow_turn_divergence_alerts",
				to: true,
				reason: "stale proof",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		store.applyFlagValueChange({
			name: "workflow_turn_divergence_alerts",
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
			{
				name: "workflow_turn_divergence_alerts",
				to: true,
				reason: "post-audit proof",
			},
			"o",
		).body as { canonical: FlagStoreCanonical; confirmToken: string };
		expect(
			handleFlagApply(deps, staged.canonical, staged.confirmToken, "o"),
		).toEqual({
			code: 200,
			body: { ok: true, warn: "apply-result audit write failed" },
		});
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
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
			name: "workflow_turn_divergence_alerts",
			envVar: "FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS",
			rawFrom: null,
			rawTo: "1",
			fileSha: computeEnvSha(ENV_CONTENT),
			effectiveFrom: false,
			effectiveTo: true,
		};
		const token = deps.tokens.issue(flagCanonicalSha(canonical));
		expect(handleFlagApply(deps, canonical, token, "o").code).toBe(409);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts")?.revision,
		).toBe(1);
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
				{
					name: "workflow_turn_divergence_alerts",
					to: true,
					reason: "must wait",
				},
				"o",
			).code,
		).toBe(409);
		expect(
			handleFlagStage(
				deps,
				{
					name: "doc_flow",
					to: true,
					project: "flywheel",
					reason: "must wait",
				},
				"o",
			).code,
		).toBe(409);
		const canonical: FlagStoreCanonical = {
			kind: "flag_store",
			batchId: "bypass-apply",
			name: "workflow_turn_divergence_alerts",
			scope: "*",
			op: "set",
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
