import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CUTOVER_STEPS,
	CutoverLedger,
	type CutoverTargetManifest,
	parseTargetManifest,
} from "../index.js";
import { executeLedgeredCommands } from "../run.js";

const roots: string[] = [];

function target(
	mode: "rehearsal" | "production" = "rehearsal",
): CutoverTargetManifest {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-cutover-"));
	chmodSync(root, 0o700);
	roots.push(root);
	const state = join(root, "state");
	return {
		v: 1,
		mode,
		windowId: "window-1",
		epoch: 1,
		homeRoot: join(root, "home"),
		productionHomeRoot: "/Users/founder",
		ledgerDir: join(state, "ledger"),
		evidenceDir: join(state, "evidence"),
		rehearsalEvidencePath: join(state, "evidence", "rehearsal-pass.json"),
		database: {
			finalPath: join(state, "flywheel-v2.db"),
			markerPath: join(state, "migration-complete.json"),
			authorityPath: join(state, "cutover-authority.json"),
			armedPath: join(state, "cutover-armed.json"),
			rollbackReceiptPath: join(state, "rollback-receipt.json"),
		},
		legacy: {
			authoritativeLiveLeadIds: ["lead-a"],
			runnerSessionDatabase: join(root, "legacy", "teamlead.db"),
			commDatabases: [join(root, "legacy", "comm.db")],
			jsonInboxRoots: [join(root, "legacy", "inboxes")],
			journalDatabases: [join(root, "legacy", "journal.db")],
			tombstonePaths: [
				join(root, "legacy", "teamlead.db"),
				join(root, "legacy", "comm.db"),
				join(root, "legacy", "inboxes"),
				join(root, "legacy", "journal.db"),
				join(root, "legacy-launchd", "bridge.plist"),
				join(root, "bin", "wrapper"),
				join(root, "credentials", "legacy.token"),
			],
			writerProcessPatterns: ["flywheel-comm"],
			launchdLabels: ["com.flywheel-rehearsal.bridge"],
			plistPaths: [join(root, "legacy-launchd", "bridge.plist")],
			stopCommands: [
				{
					apply: ["true", "com.flywheel-rehearsal.bridge"],
					verify: ["true"],
				},
			],
			credentialProbeCommands: [["false"]],
			liveFireCommands: [["false"]],
			rollbackCommands: [{ apply: ["true"], verify: ["true"] }],
		},
		controlPlane: {
			launchdLabelPrefix: "com.flywheel-rehearsal.",
			plistDirectory: join(root, "launchd"),
			tmuxSocket: join(root, "tmux.sock"),
			cmuxTarget: `rehearsal-${root.split("/").pop()}`,
			wrapperPaths: [join(root, "bin", "wrapper")],
			credentialPaths: [join(root, "credentials", "legacy.token")],
			envKeys: ["FLYWHEEL_REHEARSAL_HOME"],
			startCommands: {
				host: {
					apply: ["node", join(root, "host.js")],
					verify: ["true"],
				},
				bridge: {
					apply: ["node", join(root, "bridge.js")],
					verify: ["true"],
				},
				scheduler: {
					apply: ["node", join(root, "scheduler.js")],
					verify: ["true"],
				},
				leads: [
					{
						apply: ["node", join(root, "lead.js")],
						verify: ["true"],
					},
				],
			},
		},
		founderConfirmations: {
			heldStart: "founder-held-start-window-1",
			finalGo: "founder-final-go-window-1",
		},
		githubLaneEvidencePath: join(state, "github-lane.json"),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("cutover target manifest", () => {
	it("locks the nine design step titles and accepts a fully isolated target", () => {
		expect(CUTOVER_STEPS.map((step) => step.title)).toEqual([
			"预演",
			"冻结",
			"停全部旧写者",
			"一致快照",
			"迁移",
			"安全重置",
			"epoch fence",
			"顺序启动",
			"回滚点",
		]);
		expect(parseTargetManifest(target())).toMatchObject({
			mode: "rehearsal",
			windowId: "window-1",
			legacy: {
				authoritativeLiveLeadIds: ["lead-a"],
				runnerSessionDatabase: expect.stringMatching(/teamlead\.db$/),
			},
		});
	});

	it.each([
		[
			"production label",
			(value: CutoverTargetManifest) => {
				value.legacy.launchdLabels = ["com.flywheel.bridge"];
			},
		],
		[
			"production home",
			(value: CutoverTargetManifest) => {
				value.legacy.jsonInboxRoots = ["/Users/founder/.flywheel/inbox"];
			},
		],
		[
			"default tmux socket",
			(value: CutoverTargetManifest) => {
				value.controlPlane.tmuxSocket = "default";
			},
		],
		[
			"fence ancestor",
			(value: CutoverTargetManifest) => {
				value.legacy.tombstonePaths = [value.homeRoot];
			},
		],
		[
			"new namespace ancestor",
			(value: CutoverTargetManifest) => {
				value.homeRoot = join(value.homeRoot, "..", "legacy");
			},
		],
	])("rejects rehearsal overlap: %s", (_label, mutate) => {
		const value = target();
		mutate(value);
		expect(() => parseTargetManifest(value)).toThrow(
			/isolat|overlap|ancestor|absolute/i,
		);
	});

	it("rejects an unfenced old writer path and an unaccounted launchd label", () => {
		const missingPath = target("production");
		missingPath.legacy.tombstonePaths =
			missingPath.legacy.tombstonePaths.filter(
				(path) => path !== missingPath.legacy.commDatabases[0],
			);
		expect(() => parseTargetManifest(missingPath)).toThrow(/not covered/i);

		const missingLabel = target("production");
		missingLabel.legacy.stopCommands = [{ apply: ["true"], verify: ["true"] }];
		expect(() => parseTargetManifest(missingLabel)).toThrow(/launchd label/i);
	});

	it("rejects using the Runner registry as a comm payload database", () => {
		const value = target();
		value.legacy.commDatabases.push(
			value.legacy.runnerSessionDatabase as string,
		);
		expect(() => parseTargetManifest(value)).toThrow(
			/Runner session database.*commDatabases/i,
		);
	});

	it("normalizes system aliases but rejects an explicit symlink fence target", () => {
		const value = target();
		const real = join(roots[roots.length - 1] as string, "real-legacy");
		const link = join(roots[roots.length - 1] as string, "linked-legacy");
		chmodSync(roots[roots.length - 1] as string, 0o700);
		symlinkSync(real, link);
		value.legacy.tombstonePaths[0] = link;
		expect(() => parseTargetManifest(value)).toThrow(/symbolic link/i);
	});
});

describe("durable cutover ledger", () => {
	it("reconciles primitive intent/apply/verify/complete and skips completed replay", () => {
		const manifest = target();
		const ledger = new CutoverLedger(manifest.ledgerDir);
		const key = "bootout:com.flywheel-rehearsal.bridge";
		ledger.primitive(key, 3, "bootout launchd label", "intent", {
			loaded: true,
		});
		ledger.primitive(key, 3, "bootout launchd label", "apply");
		ledger.primitive(key, 3, "bootout launchd label", "verify");
		ledger.primitive(key, 3, "bootout launchd label", "complete");
		expect(ledger.primitiveState(key)).toMatchObject({
			status: "complete",
			preimage: { loaded: true },
		});
		expect(
			ledger.primitive(key, 3, "bootout launchd label", "complete"),
		).toMatchObject({ replayed: true });
	});

	it.each(["after_apply_ledger", "after_execute", "after_verify"] as const)(
		"reconciles a command crash at %s without duplicating the side effect",
		(faultPoint) => {
			const root = mkdtempSync(join(tmpdir(), "flywheel-v2-command-ledger-"));
			roots.push(root);
			const countPath = join(root, "count");
			const markerPath = join(root, "applied");
			const ledger = new CutoverLedger(join(root, "ledger"));
			const input = {
				ledger,
				step: 3,
				prefix: "command-recovery",
				description: "apply recovery fixture",
				commands: [
					{
						apply: [
							"/bin/sh",
							"-c",
							'printf x >> "$1"; : > "$2"',
							"apply-fixture",
							countPath,
							markerPath,
						],
						verify: ["/bin/test", "-f", markerPath],
					},
				],
			};

			expect(() =>
				executeLedgeredCommands({
					...input,
					fault(point) {
						if (point === faultPoint) throw new Error("crash");
					},
				}),
			).toThrow("crash");

			executeLedgeredCommands(input);
			expect(readFileSync(countPath, "utf8")).toBe("x");
			const [key] = [
				...readFileSync(join(root, "ledger", "ledger.jsonl"), "utf8").matchAll(
					/"primitiveKey":"([^"]+)"/g,
				),
			].map((match) => match[1]);
			expect(key).toBeDefined();
			expect(ledger.primitiveState(key as string)?.status).toBe("complete");
		},
	);

	it("detects a truncated or conflicting append-only history", () => {
		const manifest = target();
		const ledger = new CutoverLedger(manifest.ledgerDir);
		ledger.step(1, "started", []);
		writeFileSync(join(manifest.ledgerDir, "ledger.jsonl"), '{"broken":');
		expect(() => new CutoverLedger(manifest.ledgerDir)).toThrow(
			/ledger.*malformed/i,
		);
	});
});
