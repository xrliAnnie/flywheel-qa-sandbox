import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedSnapshot } from "../account-heal/model-authority-io.js";
import {
	admitOpusPair,
	type BoundedRunResult,
	classifyProbe,
	discoverOpusPair,
	emptySyncState,
	type OpusAlert,
	type OpusPair,
	observeAndAlert,
	observeOpusAuthority,
	type ProbeResult,
	parseOpusVersion,
	planOpusAuthorityUpdate,
	probeArgs,
	readSyncState,
	resolveBinary,
	runBounded,
	syncOpusModelAuthority,
	writeSyncState,
} from "../account-heal/opus-model-sync.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "opus-sync-"));
	roots.push(root);
	return root;
}

/** The production shape on 2026-09-22: Opus 5 pinned in bindings and tiers. */
const PROD_AUTHORITY = {
	version: 1,
	bindings: { opus: "claude-opus-5" },
	models: [
		{
			id: "claude-fable-5-1",
			provider: "anthropic",
			runtimeVendor: "claude",
			label: "Fable 5.1",
			aliases: ["fable-5-1"],
			dispatch: true,
		},
	],
	tiers: {
		heavy: "fable",
		medium: "claude-opus-5",
		light: "claude-opus-5",
		trivial: "claude-opus-5",
	},
	founderExtension: { keep: true },
};

function writeAuthority(root: string, doc: unknown = PROD_AUTHORITY): string {
	const path = join(root, "models.json");
	writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
	return path;
}

function usage(model: string): ProbeResult {
	return { ok: true, models: [model] };
}

/** A fake CLI: `aliasTo` is what `opus` resolves to; exact ids launch unless rejected. */
function fakeCli(aliasTo: string, rejectExact: string[] = []) {
	const calls: string[] = [];
	const probe = async (model: string): Promise<ProbeResult> => {
		calls.push(model);
		if (model === "opus") return usage(aliasTo);
		if (model === "opus[1m]") return usage(`${aliasTo}[1m]`);
		if (rejectExact.includes(model))
			return { ok: false, reason: "cli_rejected" };
		return usage(model);
	};
	return { probe, calls };
}

/** One updater observation; returns the signatures it delivered. */
function observe(
	authorityPath: string,
	statePath: string,
	deliver?: (alert: OpusAlert) => void,
): string[] {
	const delivered: string[] = [];
	observeAndAlert({
		authorityPath,
		statePath,
		deliver:
			deliver ??
			((alert) => {
				delivered.push(alert.signature);
			}),
		log: () => {},
	});
	return delivered;
}

function run(overrides: Partial<BoundedRunResult>): BoundedRunResult {
	return {
		code: 0,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		overflowed: false,
		...overrides,
	};
}

describe("FLY-2775 Opus id shape", () => {
	it("accepts one- and two-segment Opus ids only", () => {
		expect(parseOpusVersion("claude-opus-5")).toEqual([5]);
		expect(parseOpusVersion("claude-opus-5-5")).toEqual([5, 5]);
		expect(parseOpusVersion("claude-opus-6")).toEqual([6]);
	});

	it.each([
		"claude-opus-4-20250514", // dated snapshot: would outrank [5,5] if ranked
		"claude-opus-4-1-20250805",
		"claude-opus-05",
		"claude-opus-5-5[1m]",
		"claude-opus-5-5-preview",
		"claude-fable-5-1",
		"opus",
	])("fails closed on %s", (id) => {
		expect(parseOpusVersion(id)).toBeNull();
	});
});

describe("FLY-2775 probe classification", () => {
	it("reads the exact served model from modelUsage", () => {
		expect(
			classifyProbe(
				run({
					stdout: JSON.stringify({
						is_error: false,
						result: "ok",
						modelUsage: { "claude-opus-5-5[1m]": {} },
					}),
				}),
			),
		).toEqual({ ok: true, models: ["claude-opus-5-5[1m]"] });
	});

	it.each<[string, Partial<BoundedRunResult>, string]>([
		[
			"a missing binary",
			{ spawnErrorCode: "ENOENT", code: null },
			"cli_missing",
		],
		["a hung child", { timedOut: true, code: null }, "cli_timeout"],
		["oversized output", { overflowed: true }, "cli_output_invalid"],
		["non-JSON success", { stdout: "hello" }, "cli_output_invalid"],
		["non-JSON failure", { stdout: "boom", code: 1 }, "cli_rejected"],
		[
			"an auth failure",
			{ stdout: "Invalid API key · Please run /login", code: 1 },
			"cli_auth_unavailable",
		],
		[
			"a model rejection",
			{
				stdout: JSON.stringify({
					is_error: true,
					result:
						"API Error: 400 Claude Code 2.1.278 does not support this model",
				}),
				code: 1,
			},
			"cli_rejected",
		],
		[
			"no modelUsage",
			{ stdout: JSON.stringify({ is_error: false, result: "ok" }) },
			"cli_output_invalid",
		],
	])("maps %s to a distinct reason", (_label, overrides, reason) => {
		expect(classifyProbe(run(overrides))).toEqual({ ok: false, reason });
	});

	it("pins the isolated argv contract (no shell, no customizations, no persistence)", () => {
		const args = probeArgs("opus[1m]");
		expect(args.slice(0, 6)).toEqual([
			"-p",
			"Reply with exactly: ok",
			"--model",
			"opus[1m]",
			"--output-format",
			"json",
		]);
		for (const flag of [
			"--safe-mode",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--no-session-persistence",
		]) {
			expect(args).toContain(flag);
		}
		expect(args).not.toContain("--bare"); // --bare would disable OAuth/keychain auth
	});
});

describe("FLY-2775 bounded child process", () => {
	it("kills a child that never exits", async () => {
		// State, not host duration (required-wall-clock guard): the deadline
		// path fired and the child ended by signal.
		const result = await runBounded(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ timeoutMs: 300, killGraceMs: 200 },
		);
		expect(result.timedOut).toBe(true);
		expect(result.signal).not.toBeNull();
	});

	it("caps oversized output and stops the child", async () => {
		const result = await runBounded(
			process.execPath,
			["-e", "for(;;) process.stdout.write('x'.repeat(4096))"],
			{ timeoutMs: 5_000, maxBytes: 8_192, killGraceMs: 200 },
		);
		expect(result.overflowed).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(8_192);
	});

	it("reports a missing binary instead of throwing", async () => {
		const result = await runBounded(
			"/nonexistent/claude-fly2775",
			["--version"],
			{
				timeoutMs: 1_000,
			},
		);
		expect(result.spawnErrorCode).toBe("ENOENT");
		expect(classifyProbe(result)).toEqual({ ok: false, reason: "cli_missing" });
	});

	it("closes stdin so a child waiting on input cannot hang", async () => {
		const result = await runBounded(
			process.execPath,
			[
				"-e",
				"process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))",
			],
			{ timeoutMs: 3_000 },
		);
		expect(result.timedOut).toBe(false);
		expect(result.stdout).toBe("eof");
	});
});

describe("FLY-2775 discovery and admission", () => {
	it("requires a coherent base / [1m] pair", async () => {
		expect(await discoverOpusPair(fakeCli("claude-opus-5-5").probe)).toEqual({
			ok: true,
			pair: { base: "claude-opus-5-5", oneM: "claude-opus-5-5[1m]" },
		});
		const incoherent = async (model: string): Promise<ProbeResult> =>
			model === "opus" ? usage("claude-opus-5-5") : usage("claude-opus-5[1m]");
		expect(await discoverOpusPair(incoherent)).toEqual({
			ok: false,
			reason: "cli_pair_mismatch",
		});
	});

	it("propagates the CLI failure reason", async () => {
		const auth = async (): Promise<ProbeResult> => ({
			ok: false,
			reason: "cli_auth_unavailable",
		});
		expect(await discoverOpusPair(auth)).toEqual({
			ok: false,
			reason: "cli_auth_unavailable",
		});
	});

	it("admits only when both exact spellings launch", async () => {
		const pair: OpusPair = { base: "claude-opus-6", oneM: "claude-opus-6[1m]" };
		expect(await admitOpusPair(fakeCli("claude-opus-6").probe, pair)).toEqual({
			ok: true,
		});
		expect(
			await admitOpusPair(
				fakeCli("claude-opus-6", ["claude-opus-6[1m]"]).probe,
				pair,
			),
		).toEqual({ ok: false, reason: "cli_rejected" });
	});
});

describe("FLY-2775 authority plan", () => {
	const pair55: OpusPair = {
		base: "claude-opus-5-5",
		oneM: "claude-opus-5-5[1m]",
	};

	it("advances both bindings and only the managed tiers, preserving everything else", () => {
		const plan = planOpusAuthorityUpdate(
			{
				...PROD_AUTHORITY,
				tiers: { ...PROD_AUTHORITY.tiers, light: "sonnet" },
			},
			"claude-opus-5",
			pair55,
		);
		expect(plan.status).toBe("updated");
		expect(plan.authority.bindings).toEqual({
			opus: "claude-opus-5-5",
			opus1m: "claude-opus-5-5[1m]",
		});
		// An operator's non-Opus tier choice is theirs; Opus-tracking tiers follow.
		expect(plan.authority.tiers).toEqual({
			heavy: "fable",
			medium: "opus",
			light: "sonnet",
			trivial: "opus",
		});
		expect(plan.authority.founderExtension).toEqual({ keep: true });
		expect(plan.authority.models.map((m) => m.id)).toEqual([
			"claude-fable-5-1",
			"claude-opus-5-5",
			"claude-opus-5-5[1m]",
		]);
		expect(plan.authority.models[2]).toMatchObject({
			label: "Opus 5.5 (1M)",
			aliases: ["opus-5-5-1m"],
			dispatch: true,
			contextWindowTokens: 1_000_000,
		});
	});

	it("never auto-downgrades", () => {
		expect(
			planOpusAuthorityUpdate(PROD_AUTHORITY, "claude-opus-6", pair55).status,
		).toBe("unchanged");
	});

	it("normalizes a same-version authority that lacks the managed shape", () => {
		const plan = planOpusAuthorityUpdate(
			{ version: 1, bindings: { opus: "claude-opus-5-5" } },
			"claude-opus-5-5",
			pair55,
		);
		expect(plan.status).toBe("normalized");
		const again = planOpusAuthorityUpdate(
			plan.authority,
			"claude-opus-5-5",
			pair55,
		);
		expect(again.status).toBe("unchanged");
	});
});

describe("FLY-2775 syncOpusModelAuthority", () => {
	const cliVersion = async () => "2.1.280 (Claude Code)";

	it("moves the production Opus 5 authority to what the CLI launches (criterion 1)", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		expect(observe(authorityPath, statePath)).toEqual([]); // baseline
		const { probe } = fakeCli("claude-opus-5-5");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe,
			cliVersion,
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "updated",
			previousCanonical: "claude-opus-5",
			canonical: "claude-opus-5-5",
		});
		const snapshot = readVerifiedSnapshot(authorityPath);
		expect(snapshot.getDispatchCanonical("opus")).toBe("claude-opus-5-5");
		expect(snapshot.getDispatchCanonical("opus[1m]")).toBe(
			"claude-opus-5-5[1m]",
		);
		expect(snapshot.tiers.medium.id).toBe("claude-opus-5-5");
		// The generation that just retired keeps dispatching by full id.
		expect(snapshot.getDispatchCanonical("claude-opus-5")).toBe(
			"claude-opus-5",
		);
		// The version change is announced once, derived from the new authority.
		expect(observe(authorityPath, statePath)).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
		]);
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("follows a newer release with no code or manual models.json edit (criterion 3)", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		const announced = observe(authorityPath, statePath);
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			log: () => {},
		});
		announced.push(...observe(authorityPath, statePath));
		// Later the CLI updates and its `opus` alias now means a hypothetical Opus 6.
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-6").probe,
			cliVersion: async () => "2.1.300 (Claude Code)",
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "updated",
			previousCanonical: "claude-opus-5-5",
			canonical: "claude-opus-6",
		});
		const snapshot = readVerifiedSnapshot(authorityPath);
		expect(snapshot.getDispatchCanonical("opus")).toBe("claude-opus-6");
		expect(snapshot.getDispatchCanonical("opus-1m")).toBe("claude-opus-6[1m]");
		expect(snapshot.getModelRegistryEntry("claude-opus-6")?.label).toBe(
			"Opus 6",
		);
		// Every previous generation stays dispatchable for in-flight snapshots.
		for (const id of [
			"claude-opus-5-5",
			"claude-opus-5-5[1m]",
			"claude-opus-5",
		]) {
			expect(snapshot.getDispatchCanonical(id)).toBe(id);
		}
		announced.push(...observe(authorityPath, statePath));
		expect(announced).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
			"model-family-updated-opus-claude-opus-5-5-claude-opus-6",
		]);
	});

	it("survives two successive upgrades", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		for (const [alias, version] of [
			["claude-opus-6", "2.1.300"],
			["claude-opus-6-1", "2.1.310"],
		] as const) {
			const result = await syncOpusModelAuthority({
				authorityPath,
				statePath,
				probe: fakeCli(alias).probe,
				cliVersion: async () => version,
				log: () => {},
			});
			expect(result.status).toBe("updated");
		}
		const snapshot = readVerifiedSnapshot(authorityPath);
		expect(snapshot.getDispatchCanonical("opus")).toBe("claude-opus-6-1");
		for (const id of [
			"claude-opus-6",
			"claude-opus-6[1m]",
			"claude-opus-5-5",
		]) {
			expect(snapshot.getDispatchCanonical(id)).toBe(id);
		}
	});

	// Bridge review 1458e9d5 [0]: FLY-1496 — a retired generation is
	// dispatchable by id (in-flight runs) but never offered to new work.
	it("retires the outgoing pair from every picker on the next advance", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		for (const [alias, version] of [
			["claude-opus-5-5", "2.1.280"],
			["claude-opus-6", "2.1.300"],
		] as const) {
			await syncOpusModelAuthority({
				authorityPath,
				statePath,
				probe: fakeCli(alias).probe,
				cliVersion: async () => version,
				log: () => {},
			});
		}
		const snapshot = readVerifiedSnapshot(authorityPath);
		for (const surface of ["lead", "runner", "workflow", "cron"] as const) {
			for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]"]) {
				expect(snapshot.isModelSelectable({ surface, model: id })).toBe(false);
			}
			expect(
				snapshot.isModelSelectable({ surface, model: "claude-opus-6" }),
			).toBe(true);
		}
		for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]"]) {
			expect(snapshot.getDispatchCanonical(id)).toBe(id);
		}
	});

	it("retains everything when the alias resolves but the exact id is rejected", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const bytes = readFileSync(authorityPath, "utf8");
		const statePath = join(root, "state.json");
		expect(observe(authorityPath, statePath)).toEqual([]);
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5", ["claude-opus-5-5"]).probe,
			cliVersion,
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "retained",
			reason: "cli_rejected",
		});
		expect(readFileSync(authorityPath, "utf8")).toBe(bytes);
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("does not pay for a second probe while the CLI version is unchanged", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		const first = fakeCli("claude-opus-5-5");
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: first.probe,
			cliVersion,
			now: () => 1_000,
			log: () => {},
		});
		expect(first.calls.sort()).toEqual(
			["claude-opus-5-5", "claude-opus-5-5[1m]", "opus", "opus[1m]"].sort(),
		);
		const second = fakeCli("claude-opus-5-5");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: second.probe,
			cliVersion,
			now: () => 2_000,
			log: () => {},
		});
		expect(result).toMatchObject({ status: "retained", reason: "cooldown" });
		expect(second.calls).toEqual([]);
		// A new CLI version is a new mapping: probe again.
		const third = fakeCli("claude-opus-5-5");
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: third.probe,
			cliVersion: async () => "2.1.281 (Claude Code)",
			now: () => 3_000,
			log: () => {},
		});
		expect(third.calls).toEqual(expect.arrayContaining(["opus", "opus[1m]"]));
	});

	it("still normalizes during cooldown when the authority drifted", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			now: () => 1_000,
			log: () => {},
		});
		writeAuthority(root, PROD_AUTHORITY); // an operator restored the old file
		const probe = fakeCli("claude-opus-5-5");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: probe.probe,
			cliVersion,
			now: () => 2_000,
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "updated",
			canonical: "claude-opus-5-5",
		});
		expect(probe.calls).toEqual([]); // the cached, already-admitted pair was reused
	});

	it("treats a corrupt state file as empty and re-probes", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		writeFileSync(statePath, "{not json", { mode: 0o600 });
		const probe = fakeCli("claude-opus-5-5");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: probe.probe,
			cliVersion,
			log: () => {},
		});
		expect(result.status).toBe("updated");
		expect(probe.calls).toContain("opus");
	});

	it("rolls back, and announces nothing, when post-write verification fails", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		const bytes = readFileSync(authorityPath, "utf8");
		expect(observe(authorityPath, statePath)).toEqual([]);
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			// A concurrent writer clobbers the file with a DIFFERENT binding. (An empty
			// `{"version":1}` would fall back to the built-in default, which is
			// already 5.5, and verification would pass by coincidence.)
			afterWrite: (path) =>
				writeFileSync(
					path,
					`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5" } })}\n`,
				),
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "retained",
			reason: "verification_failed",
		});
		expect(readFileSync(authorityPath, "utf8")).toBe(bytes);
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("reports rollback_failed with a severe model_config alert when restoring also fails", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			// A concurrent writer clobbers the file with a DIFFERENT binding. (An empty
			// `{"version":1}` would fall back to the built-in default, which is
			// already 5.5, and verification would pass by coincidence.)
			afterWrite: (path) =>
				writeFileSync(
					path,
					`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5" } })}\n`,
				),
			rollbackWrite: () => {
				throw new Error("disk full");
			},
			log: () => {},
		});
		// Persisted, so the observer delivers and retries it.
		expect(result).toMatchObject({
			status: "retained",
			reason: "rollback_failed",
		});
		expect(result.alert).toBeUndefined();
		expect(readSyncState(statePath).rollbackFailure?.alert).toMatchObject({
			kind: "model_config",
			severity: "severe",
		});
	});

	it("does nothing, and probes nothing, when disabled", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const probe = fakeCli("claude-opus-5-5");
		expect(
			await syncOpusModelAuthority({
				authorityPath,
				statePath: join(root, "state.json"),
				disabled: true,
				probe: probe.probe,
				cliVersion,
			}),
		).toEqual({ status: "retained", reason: "disabled" });
		expect(probe.calls).toEqual([]);
	});

	it("retains with the CLI's own reason when the binary is missing", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		expect(
			await syncOpusModelAuthority({
				authorityPath,
				statePath: join(root, "state.json"),
				probe: fakeCli("claude-opus-5-5").probe,
				cliVersion: async () => "cli_missing",
			}),
		).toMatchObject({ status: "retained", reason: "cli_missing" });
	});
});

describe("FLY-2775 derived version-change alerts", () => {
	const MOVED = {
		...PROD_AUTHORITY,
		bindings: { opus: "claude-opus-5-5", opus1m: "claude-opus-5-5[1m]" },
	};

	it("classifies the authority as runs would see it", () => {
		const root = scratch();
		expect(observeOpusAuthority(writeAuthority(root)).state).toBe("legacy");
		expect(observeOpusAuthority(writeAuthority(root, MOVED))).toEqual({
			state: "consistent",
			opus: "claude-opus-5-5",
			oneM: "claude-opus-5-5[1m]",
		});
		writeFileSync(join(root, "models.json"), "{not json");
		expect(observeOpusAuthority(join(root, "models.json")).state).toBe(
			"broken",
		);
		// No file at all is the documented built-ins configuration.
		expect(observeOpusAuthority(join(root, "absent.json")).state).toBe(
			"consistent",
		);
	});

	it("baselines silently, then announces a move exactly once", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		expect(observe(authorityPath, statePath)).toEqual([]);
		expect(readSyncState(statePath).notifiedOpus).toBe("claude-opus-5");
		// Any writer — this sync, a run that crashed after renaming, another
		// host — the move is derived from the file, never lost with a queue.
		writeAuthority(root, MOVED);
		expect(observe(authorityPath, statePath)).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
		]);
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("keeps the watermark when delivery fails, so the next run retries once", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath);
		writeAuthority(root, MOVED);
		observe(authorityPath, statePath, () => {
			throw new Error("lead-alert down");
		});
		expect(readSyncState(statePath).notifiedOpus).toBe("claude-opus-5");
		expect(observe(authorityPath, statePath)).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
		]);
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("never announces success over a non-managed (legacy) authority", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root, MOVED);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath);
		// Someone rewrites a half-moved file: dispatchable, but not the pair.
		writeAuthority(root, {
			...PROD_AUTHORITY,
			bindings: { opus: "claude-opus-5" },
		});
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("pages severe, keyed by content, while the authority is unusable", () => {
		const root = scratch();
		const authorityPath = join(root, "models.json");
		const statePath = join(root, "state.json");
		writeFileSync(authorityPath, "{not json");
		const alerts: OpusAlert[] = [];
		observe(authorityPath, statePath, (alert) => alerts.push(alert));
		observe(authorityPath, statePath, (alert) => alerts.push(alert));
		expect(alerts).toHaveLength(2);
		expect(alerts[0]).toMatchObject({
			kind: "model_config",
			severity: "severe",
		});
		// Same bytes ⇒ same signature ⇒ lead-alert dedups the repeat.
		expect(alerts[1]?.signature).toBe(alerts[0]?.signature);
		writeFileSync(authorityPath, "{still not json");
		observe(authorityPath, statePath, (alert) => alerts.push(alert));
		expect(alerts[2]?.signature).not.toBe(alerts[0]?.signature);
	});

	it("a sync that started earlier never rewinds the alert watermark (R2 race)", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath); // watermark = claude-opus-5
		const cli = fakeCli("claude-opus-5-5");
		let raced = false;
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			cliVersion: async () => "2.1.280 (Claude Code)",
			probe: async (model) => {
				if (!raced) {
					raced = true;
					// A concurrent updater run announces 5.5 while this one probes.
					writeSyncState(statePath, {
						...readSyncState(statePath),
						notifiedOpus: "claude-opus-5-5",
					});
				}
				return cli.probe(model);
			},
			log: () => {},
		});
		expect(readSyncState(statePath).notifiedOpus).toBe("claude-opus-5-5");
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("records every delivered transition in a bounded history", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath);
		writeAuthority(root, MOVED);
		observe(authorityPath, statePath);
		expect(readSyncState(statePath).history).toEqual([
			expect.objectContaining({ from: "claude-opus-5", to: "claude-opus-5-5" }),
		]);
	});

	it("reports an unwritable state file instead of silently losing the baseline (R3 B1)", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		writeFileSync(join(root, "not-a-dir"), "x");
		const result = observeAndAlert({
			authorityPath,
			statePath: join(root, "not-a-dir", "state.json"),
			deliver: () => {},
			log: () => {},
		});
		expect(result.stateWritable).toBe(false);
	});

	it("two overlapping observers never rewind the watermark (R3 M1)", () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath); // watermark = claude-opus-5
		writeAuthority(root, MOVED);
		const OPUS6 = {
			...PROD_AUTHORITY,
			models: [
				...PROD_AUTHORITY.models,
				{
					id: "claude-opus-6",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Opus 6",
					aliases: ["opus-6"],
					dispatch: true,
				},
				{
					id: "claude-opus-6[1m]",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Opus 6 (1M)",
					aliases: ["opus-6-1m"],
					dispatch: true,
					contextWindowTokens: 1_000_000,
				},
			],
			bindings: { opus: "claude-opus-6", opus1m: "claude-opus-6[1m]" },
		};
		const delivered: string[] = [];
		observe(authorityPath, statePath, (alert) => {
			delivered.push(alert.signature);
			// While this run is delivering 5 -> 5.5, another run sees Opus 6.
			writeAuthority(root, OPUS6);
			observe(authorityPath, statePath, (inner) =>
				delivered.push(inner.signature),
			);
		});
		expect(readSyncState(statePath).notifiedOpus).toBe("claude-opus-6");
		expect(observe(authorityPath, statePath)).toEqual([]);
		expect(delivered).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
			"model-family-updated-opus-claude-opus-5-claude-opus-6",
		]);
		// R4 #3: every DELIVERED transition is in the record, even the one
		// whose watermark write was (correctly) declined.
		expect(
			(readSyncState(statePath).history ?? []).map((t) => `${t.from}>${t.to}`),
		).toEqual(["claude-opus-5>claude-opus-6", "claude-opus-5>claude-opus-5-5"]);
	});

	it("round-trips the state file", () => {
		const root = scratch();
		const path = join(root, "nested", "state.json");
		writeSyncState(path, {
			...emptySyncState(),
			notifiedOpus: "claude-opus-5-5",
		});
		expect(readSyncState(path).notifiedOpus).toBe("claude-opus-5-5");
	});
});

// Codex code review (rework) findings — each case is the reviewer's repro.
describe("FLY-2775 code review R1 regressions", () => {
	const cliVersion = async () => "2.1.280 (Claude Code)";

	it("B1: never normalizes to a pair whose exact ids failed admission", async () => {
		const root = scratch();
		// bindings.opus already equals the discovered base; only opus1m/tiers drift.
		const authorityPath = writeAuthority(root, {
			version: 1,
			bindings: { opus: "claude-opus-5-5" },
		});
		const bytes = readFileSync(authorityPath, "utf8");
		const cli = fakeCli("claude-opus-5-5", [
			"claude-opus-5-5",
			"claude-opus-5-5[1m]",
		]);
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath: join(root, "state.json"),
			probe: cli.probe,
			cliVersion,
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "retained",
			reason: "cli_rejected",
		});
		expect(cli.calls).toEqual(expect.arrayContaining(["claude-opus-5-5"]));
		expect(readFileSync(authorityPath, "utf8")).toBe(bytes);
	});

	it("B2: an unwritable state file never blocks or corrupts the authority move", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		// The state file's parent is a regular file: every state write fails.
		writeFileSync(join(root, "not-a-dir"), "x");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath: join(root, "not-a-dir", "state.json"),
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			log: () => {},
		});
		expect(result).toMatchObject({ status: "updated" });
		expect(observeOpusAuthority(authorityPath)).toMatchObject({
			state: "consistent",
			opus: "claude-opus-5-5",
		});
	});

	it("B2: a failed authority write announces nothing", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		expect(observe(authorityPath, statePath)).toEqual([]);
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			beforeRename: () => {
				throw new Error("disk full");
			},
			log: () => {},
		});
		expect(result).toMatchObject({
			status: "retained",
			reason: "write_failed",
		});
		expect(observe(authorityPath, statePath)).toEqual([]);
	});

	it("B2: rollback_failed is handed back for direct delivery even with an unwritable state dir", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const stateDir = join(root, "state");
		mkdirSync(stateDir);
		const statePath = join(stateDir, "state.json");
		try {
			const result = await syncOpusModelAuthority({
				authorityPath,
				statePath,
				probe: fakeCli("claude-opus-5-5").probe,
				cliVersion,
				afterWrite: (path) => {
					writeFileSync(
						path,
						`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5" } })}\n`,
					);
					// From here on the state directory refuses every write.
					chmodSync(stateDir, 0o500);
				},
				rollbackWrite: () => {
					throw new Error("disk full");
				},
				log: () => {},
			});
			expect(result).toMatchObject({
				status: "retained",
				reason: "rollback_failed",
				alert: { kind: "model_config", severity: "severe" },
			});
		} finally {
			chmodSync(stateDir, 0o700);
		}
	});

	it("M1: cooldown still normalizes drift when the bindings already match", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			now: () => 1_000,
			log: () => {},
		});
		const doc = JSON.parse(readFileSync(authorityPath, "utf8"));
		doc.tiers.medium = "claude-opus-5-5"; // drift an Opus-tracking tier to an exact id
		writeFileSync(authorityPath, `${JSON.stringify(doc, null, 2)}\n`, {
			mode: 0o600,
		});
		const probe = fakeCli("claude-opus-5-5");
		const result = await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: probe.probe,
			cliVersion,
			now: () => 2_000,
			log: () => {},
		});
		expect(result.status).toBe("normalized");
		expect(probe.calls).toEqual([]);
		expect(JSON.parse(readFileSync(authorityPath, "utf8")).tiers.medium).toBe(
			"opus",
		);
	});

	it("M2: the cooldown key is the PATH-resolved real binary, not the literal name", () => {
		const root = scratch();
		const real = join(root, "versions", "2.1.280");
		mkdirSync(join(root, "versions"), { recursive: true });
		writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
		mkdirSync(join(root, "bin"));
		symlinkSync(real, join(root, "bin", "claude"));
		expect(resolveBinary("claude", `/nonexistent:${join(root, "bin")}`)).toBe(
			realpathSync(real),
		);
		expect(resolveBinary("claude", "/nonexistent")).toBe("claude");
	});

	it("B3: retains nothing past the cap even when the child ignores SIGTERM", async () => {
		const result = await runBounded(
			process.execPath,
			[
				"-e",
				"process.on('SIGTERM',()=>{}); const b='x'.repeat(4096); setInterval(()=>process.stdout.write(b),1)",
			],
			{ timeoutMs: 5_000, maxBytes: 8_192, killGraceMs: 300 },
		);
		expect(result.overflowed).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(8_192);
	});

	it("B3: still SIGKILLs a SIGTERM-ignoring descendant after the direct child exits", async () => {
		const root = scratch();
		const pidFile = join(root, "grandchild.pid");
		const result = await runBounded(
			process.execPath,
			[
				"-e",
				`const {spawn}=require('node:child_process');const fs=require('node:fs');
				 const g=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
				 fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));
				 setInterval(()=>{},1000);`,
			],
			{ timeoutMs: 500, killGraceMs: 300 },
		);
		expect(result.timedOut).toBe(true);
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 900));
		let alive = true;
		try {
			process.kill(grandchild, 0);
		} catch {
			alive = false;
		}
		if (alive) process.kill(grandchild, "SIGKILL");
		expect(alive).toBe(false);
	});

	it("B3 (R2): the group is gone before an exiting CLI-shaped process returns", async () => {
		// Production shape: runBounded resolves, then the CLI calls process.exit
		// at once — nothing unref'd may be left to finish the cleanup.
		const root = scratch();
		const pidFile = join(root, "grandchild.pid");
		const harness = join(root, "harness.mts");
		const moduleUrl = new URL(
			"../account-heal/opus-model-sync.ts",
			import.meta.url,
		);
		writeFileSync(
			harness,
			`import { runBounded } from ${JSON.stringify(moduleUrl.href)};
const script = ${JSON.stringify(
				`const {spawn}=require('node:child_process');const fs=require('node:fs');
				 const g=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
				 fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));
				 setInterval(()=>{},1000);`,
			)};
const result = await runBounded(process.execPath, ["-e", script], { timeoutMs: 500, killGraceMs: 300 });
process.exit(result.timedOut ? 0 : 3);
`,
		);
		const { spawnSync } = await import("node:child_process");
		const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
		const exited = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href,
				harness,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(exited.stderr).toBe("");
		expect(exited.status).toBe(0);
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		// SIGKILL was delivered before exit; allow only for the kernel to reap.
		let alive = true;
		for (let i = 0; i < 10 && alive; i += 1) {
			try {
				process.kill(grandchild, 0);
				await new Promise((resolve) => setTimeout(resolve, 20));
			} catch {
				alive = false;
			}
		}
		if (alive) process.kill(grandchild, "SIGKILL");
		expect(alive).toBe(false);
	});
});

// Codex code review (rework) R3 findings — each case is the reviewer's repro.
describe("FLY-2775 code review R3 regressions", () => {
	const cliVersion = async () => "2.1.280 (Claude Code)";

	/** A transaction whose post-write verification fails on a tier, and whose rollback fails. */
	async function rollbackFailedLeavingAPlausiblePair(
		root: string,
		authorityPath: string,
		statePath: string,
	) {
		return syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			// The binding pair lands, but a managed tier is clobbered — the
			// transaction rejects it; the observer alone would call it moved.
			afterWrite: (path) =>
				writeFileSync(
					path,
					`${JSON.stringify({
						...PROD_AUTHORITY,
						bindings: {
							opus: "claude-opus-5-5",
							opus1m: "claude-opus-5-5[1m]",
						},
						tiers: { ...PROD_AUTHORITY.tiers, medium: "fable" },
					})}\n`,
				),
			rollbackWrite: () => {
				throw new Error("disk full");
			},
			log: () => {},
		});
	}

	it("B2: no success alert over an authority a failed transaction left behind", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath); // baseline claude-opus-5
		const result = await rollbackFailedLeavingAPlausiblePair(
			root,
			authorityPath,
			statePath,
		);
		expect(result.reason).toBe("rollback_failed");
		const alerts: OpusAlert[] = [];
		observe(authorityPath, statePath, (alert) => alerts.push(alert));
		expect(alerts.map((a) => a.kind)).toEqual(["model_config"]);
		// A later sync that VERIFIES the authority resolves the failure; only
		// then is the move announced.
		await syncOpusModelAuthority({
			authorityPath,
			statePath,
			probe: fakeCli("claude-opus-5-5").probe,
			cliVersion,
			log: () => {},
		});
		expect(observe(authorityPath, statePath)).toEqual([
			"model-family-updated-opus-claude-opus-5-claude-opus-5-5",
		]);
		expect(readSyncState(statePath).rollbackFailure).toBeUndefined();
	});

	it("B3: the rollback_failed alert is retried until delivered, exactly once", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const statePath = join(root, "state.json");
		observe(authorityPath, statePath);
		await rollbackFailedLeavingAPlausiblePair(root, authorityPath, statePath);
		observe(authorityPath, statePath, () => {
			throw new Error("lead-alert down");
		});
		const severe: string[] = [];
		const collect = (alert: OpusAlert) => {
			if (alert.kind === "model_config") severe.push(alert.signature);
		};
		observe(authorityPath, statePath, collect);
		observe(authorityPath, statePath, collect);
		expect(severe).toHaveLength(1);
		expect(readSyncState(statePath).rollbackFailure?.deliveredAt).toEqual(
			expect.any(Number),
		);
	});

	it("M2: a normal exit leaves no same-group descendant behind", async () => {
		const root = scratch();
		const pidFile = join(root, "grandchild.pid");
		const harness = join(root, "harness.mts");
		const moduleUrl = new URL(
			"../account-heal/opus-model-sync.ts",
			import.meta.url,
		);
		// The direct child daemonizes a SIGTERM-ignoring grandchild in its own
		// process group, then exits 0; the harness exits right after.
		writeFileSync(
			harness,
			`import { runBounded } from ${JSON.stringify(moduleUrl.href)};
const script = ${JSON.stringify(
				`const {spawn}=require('node:child_process');const fs=require('node:fs');
				 const g=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
				 g.unref();
				 fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));
				 process.exit(0);`,
			)};
const result = await runBounded(process.execPath, ["-e", script], { timeoutMs: 10000, killGraceMs: 300 });
process.exit(result.code === 0 && !result.timedOut ? 0 : 3);
`,
		);
		const { spawnSync } = await import("node:child_process");
		const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
		const exited = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href,
				harness,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(exited.stderr).toBe("");
		expect(exited.status).toBe(0);
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		for (let i = 0; i < 10 && alive; i += 1) {
			try {
				process.kill(grandchild, 0);
				await new Promise((resolve) => setTimeout(resolve, 20));
			} catch {
				alive = false;
			}
		}
		if (alive) process.kill(grandchild, "SIGKILL");
		expect(alive).toBe(false);
	});
});

// Codex code review (rework) R4 findings — final round (Lead ruling).
describe("FLY-2775 code review R4 regressions", () => {
	it("#4: a persisted rollback failure still pages when the state dir is unwritable", async () => {
		const root = scratch();
		const authorityPath = writeAuthority(root);
		const stateDir = join(root, "state");
		mkdirSync(stateDir);
		const statePath = join(stateDir, "state.json");
		writeSyncState(statePath, {
			...emptySyncState(),
			notifiedOpus: "claude-opus-5",
			rollbackFailure: {
				alert: {
					signature: "model-family-rollback-failed-opus-a-b-1",
					kind: "model_config",
					severity: "severe",
					title: "t",
					body: "b",
				},
				at: 1,
			},
		});
		chmodSync(stateDir, 0o500);
		try {
			const kinds: string[] = [];
			const result = observeAndAlert({
				authorityPath,
				statePath,
				deliver: (alert) => kinds.push(alert.kind),
				log: () => {},
			});
			expect(result.stateWritable).toBe(false);
			expect(kinds).toEqual(["model_config"]);
		} finally {
			chmodSync(stateDir, 0o700);
		}
	});
});
