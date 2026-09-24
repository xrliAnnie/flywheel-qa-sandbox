import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type OpusAlert,
	type SyncOpusModelAuthorityResult,
	writeSyncState,
} from "../account-heal/opus-model-sync.js";
import {
	deliverViaLeadAlert,
	readOpusModelSyncDisabled,
	runOpusModelSyncCli,
} from "../account-heal/opus-model-sync-cli.js";
import { initializeFlagStore } from "../bridge/flag-store-runtime.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const MOVED_SIGNATURE =
	"model-family-updated-opus-claude-opus-5-claude-opus-5-5";

/**
 * An authority another writer already moved to Opus 5.5 while the last
 * announced binding is still Opus 5: every CLI run owes one version alert.
 */
function movedAuthority(): string[] {
	const root = mkdtempSync(join(tmpdir(), "opus-cli-"));
	roots.push(root);
	const authorityPath = join(root, "models.json");
	writeFileSync(
		authorityPath,
		`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5-5", opus1m: "claude-opus-5-5[1m]" } })}\n`,
		{ mode: 0o600 },
	);
	const statePath = join(root, "state.json");
	writeSyncState(statePath, {
		version: 1,
		admitted: [],
		notifiedOpus: "claude-opus-5",
	});
	return ["--authority", authorityPath, "--state", statePath];
}

const updated: SyncOpusModelAuthorityResult = {
	status: "updated",
	previousCanonical: "claude-opus-5",
	canonical: "claude-opus-5-5",
};

describe("FLY-2775 opus-model-sync CLI", () => {
	it("honors the kill switch without calling the sync, and still derives alerts", async () => {
		let synced = 0;
		const delivered: string[] = [];
		const warnings: string[] = [];
		const code = await runOpusModelSyncCli({
			argv: movedAuthority(),
			env: {},
			readDisabled: () => true,
			sync: async () => {
				synced += 1;
				return updated;
			},
			deliver: (n) => delivered.push(n.signature),
			log: () => {},
			warn: (m) => warnings.push(m),
		});
		expect(code).toBe(0);
		expect(synced).toBe(0);
		expect(delivered).toEqual([MOVED_SIGNATURE]);
		expect(warnings.join("\n")).toMatch(/opus_model_sync_disabled/);
	});

	it("re-derives an undelivered alert on the next run and delivers it exactly once", async () => {
		const argv = movedAuthority();
		const common = {
			argv,
			env: {},
			readDisabled: () => false,
			sync: async (): Promise<SyncOpusModelAuthorityResult> => ({
				status: "retained",
				reason: "cooldown",
			}),
			log: () => {},
			warn: () => {},
		};
		await runOpusModelSyncCli({
			...common,
			deliver: () => {
				throw new Error("lead-alert unavailable");
			},
		});
		const delivered: OpusAlert[] = [];
		await runOpusModelSyncCli({ ...common, deliver: (n) => delivered.push(n) });
		await runOpusModelSyncCli({ ...common, deliver: (n) => delivered.push(n) });
		expect(delivered.map((n) => n.signature)).toEqual([MOVED_SIGNATURE]);
	});

	it("never moves the authority when the state file cannot record it (R3 B1)", async () => {
		const [, authorityPath] = movedAuthority();
		const root = mkdtempSync(join(tmpdir(), "opus-cli-"));
		roots.push(root);
		writeFileSync(join(root, "not-a-dir"), "x");
		let synced = 0;
		const warnings: string[] = [];
		const code = await runOpusModelSyncCli({
			argv: [
				"--authority",
				authorityPath!,
				"--state",
				join(root, "not-a-dir", "state.json"),
			],
			env: {},
			readDisabled: () => false,
			sync: async () => {
				synced += 1;
				return updated;
			},
			deliver: () => {},
			log: () => {},
			warn: (m) => warnings.push(m),
		});
		expect(code).toBe(0);
		expect(synced).toBe(0);
		expect(warnings).toContain(
			"[opus-model-sync] authority retained: state_unwritable",
		);
	});

	it("R4 #1: a run that finds a live holder of the run lock touches nothing", async () => {
		const argv = movedAuthority();
		const statePath = argv[3]!;
		writeFileSync(`${statePath}.lock`, String(process.pid));
		let synced = 0;
		const delivered: string[] = [];
		const logs: string[] = [];
		await runOpusModelSyncCli({
			argv,
			env: {},
			readDisabled: () => false,
			sync: async () => {
				synced += 1;
				return updated;
			},
			deliver: (n) => delivered.push(n.signature),
			log: (m) => logs.push(m),
			warn: () => {},
		});
		expect(synced).toBe(0);
		expect(delivered).toEqual([]);
		expect(logs.join("\n")).toMatch(/sync_in_progress/);
	});

	it("R4 #1: a dead holder's lock is reclaimed, and released after the run", async () => {
		const argv = movedAuthority();
		const statePath = argv[3]!;
		writeFileSync(`${statePath}.lock`, "2147483646");
		let synced = 0;
		await runOpusModelSyncCli({
			argv,
			env: {},
			readDisabled: () => false,
			sync: async () => {
				synced += 1;
				return updated;
			},
			deliver: () => {},
			log: () => {},
			warn: () => {},
		});
		expect(synced).toBe(1);
		expect(existsSync(`${statePath}.lock`)).toBe(false);
	});

	it("R4 #2: an unrecorded rollback failure is never followed by a success alert", async () => {
		const root = mkdtempSync(join(tmpdir(), "opus-cli-"));
		roots.push(root);
		const authorityPath = join(root, "models.json");
		writeFileSync(
			authorityPath,
			`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5" } })}\n`,
		);
		const statePath = join(root, "state.json");
		const attempted: string[] = [];
		await runOpusModelSyncCli({
			argv: ["--authority", authorityPath, "--state", statePath],
			env: {},
			readDisabled: () => false,
			// The failed transaction leaves a coherent-looking 5.5 pair behind,
			// and its marker could not be written.
			sync: async () => {
				writeFileSync(
					authorityPath,
					`${JSON.stringify({ version: 1, bindings: { opus: "claude-opus-5-5", opus1m: "claude-opus-5-5[1m]" } })}\n`,
				);
				return {
					status: "retained",
					reason: "rollback_failed",
					alert: {
						signature: "model-family-rollback-failed-opus-x",
						kind: "model_config",
						severity: "severe",
						title: "t",
						body: "b",
					},
				};
			},
			deliver: (n) => {
				attempted.push(n.kind);
				if (n.kind === "model_config") throw new Error("lead-alert down");
			},
			log: () => {},
			warn: () => {},
		});
		expect(attempted).toEqual(["model_config"]);
	});

	it("delivers a rollback_failed alert from the sync result directly", async () => {
		const delivered: OpusAlert[] = [];
		const alert: OpusAlert = {
			signature: "model-family-rollback-failed-opus-a-b-1",
			kind: "model_config",
			severity: "severe",
			title: "Opus model authority rollback failed — manual check needed",
			body: "body",
		};
		await runOpusModelSyncCli({
			argv: movedAuthority(),
			env: {},
			readDisabled: () => false,
			sync: async () => ({
				status: "retained",
				reason: "rollback_failed",
				alert,
			}),
			deliver: (n) => delivered.push(n),
			log: () => {},
			warn: () => {},
		});
		expect(delivered.map((n) => n.signature)).toContain(alert.signature);
	});

	it("is advisory: a throwing sync still exits 0 with a warning", async () => {
		const warnings: string[] = [];
		const code = await runOpusModelSyncCli({
			argv: movedAuthority(),
			env: {},
			readDisabled: () => false,
			sync: async () => {
				throw new Error("boom");
			},
			deliver: () => {},
			log: () => {},
			warn: (m) => warnings.push(m),
		});
		expect(code).toBe(0);
		expect(warnings.join("\n")).toMatch(/retained current authority/);
	});

	it("surfaces operator-actionable retain reasons", async () => {
		const warnings: string[] = [];
		await runOpusModelSyncCli({
			argv: movedAuthority(),
			env: {},
			readDisabled: () => false,
			sync: async () => ({
				status: "retained",
				reason: "cli_auth_unavailable",
			}),
			deliver: () => {},
			log: () => {},
			warn: (m) => warnings.push(m),
		});
		expect(warnings).toContain(
			"[opus-model-sync] authority retained: cli_auth_unavailable",
		);
	});

	it("passes FLYWHEEL_CLAUDE_BIN through to the sync", async () => {
		let seen: string | undefined;
		await runOpusModelSyncCli({
			argv: movedAuthority(),
			env: { FLYWHEEL_CLAUDE_BIN: "/opt/claude/bin/claude" },
			readDisabled: () => false,
			sync: async (opts) => {
				seen = opts.claudeBin;
				return updated;
			},
			deliver: () => {},
			log: () => {},
			warn: () => {},
		});
		expect(seen).toBe("/opt/claude/bin/claude");
	});

	it("delivers through lead-alert.sh with the alert's severity and signature", () => {
		const calls: Array<{ bin: string; args: string[] }> = [];
		deliverViaLeadAlert(
			{
				signature: "sig-1",
				kind: "model_config",
				severity: "severe",
				title: "Opus model authority rollback failed — manual check needed",
				body: "body",
			},
			{
				alertBin: "/x/lead-alert.sh",
				execFile: ((bin: string, args: string[]) => {
					calls.push({ bin, args });
					return Buffer.from("");
				}) as never,
			},
		);
		expect(calls[0]?.bin).toBe("/x/lead-alert.sh");
		const args = calls[0]?.args ?? [];
		expect(args[args.indexOf("--kind") + 1]).toBe("model_config");
		expect(args[args.indexOf("--severity") + 1]).toBe("severe");
		expect(args[args.indexOf("--signature") + 1]).toBe("sig-1");
	});
});

describe("FLY-2775 opus_model_sync_disabled read out of process", () => {
	it("reads the managed flag through a read-only teamlead.db handle", async () => {
		const root = mkdtempSync(join(tmpdir(), "opus-flag-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const store = await StateStore.create(dbPath);
		try {
			initializeFlagStore(store, {});
			expect(readOpusModelSyncDisabled(dbPath, () => {})).toBe(false);
			const revision = store.getFlagValueRow(
				"opus_model_sync_disabled",
			)!.revision;
			expect(
				store.applyFlagValueChange({
					name: "opus_model_sync_disabled",
					rawTo: "1",
					expectedRevision: revision,
					actor: "bridge-local-operator",
					reason: "freeze the Opus line during a model incident",
				}),
			).toMatchObject({ ok: true });
			store.save();
			expect(readOpusModelSyncDisabled(dbPath, () => {})).toBe(true);
		} finally {
			store.close();
		}
	});

	// Bridge review 1458e9d5 [1]: an emergency stop must not fail open.
	it("treats an unreadable store as DISABLED (fail closed), with a warning", () => {
		const warnings: string[] = [];
		expect(
			readOpusModelSyncDisabled("/nonexistent/fly2775/teamlead.db", (m) =>
				warnings.push(m),
			),
		).toBe(true);
		expect(warnings.join("\n")).toMatch(/kill switch unreadable/);
	});

	it("reads the kill switch from the --db store the updater passes", async () => {
		let seen: string | undefined;
		await runOpusModelSyncCli({
			argv: [...movedAuthority(), "--db", "/srv/flywheel/teamlead.db"],
			env: {},
			readDisabled: (dbPath) => {
				seen = dbPath;
				return true;
			},
			sync: async () => updated,
			deliver: () => {},
			log: () => {},
			warn: () => {},
		});
		expect(seen).toBe("/srv/flywheel/teamlead.db");
	});
});
