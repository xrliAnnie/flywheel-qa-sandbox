import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

test("the nine-step rehearsal leaves its production sentinel unchanged", () => {
	const targetRoot = mkdtempSync(join(tmpdir(), "fly1502-rehearsal-target-"));
	const productionRoot = mkdtempSync(
		join(tmpdir(), "fly1502-production-sentinel-"),
	);
	try {
		const homeRoot = join(targetRoot, "home");
		const stateRoot = join(targetRoot, "state");
		const legacyRoot = join(targetRoot, "legacy");
		const evidenceDir = join(stateRoot, "evidence");
		const binRoot = join(targetRoot, "bin");
		for (const path of [
			homeRoot,
			stateRoot,
			legacyRoot,
			evidenceDir,
			binRoot,
		]) {
			mkdirSync(path, { recursive: true, mode: 0o700 });
		}
		const launchctl = join(binRoot, "launchctl");
		writeFileSync(
			launchctl,
			[
				"#!/bin/sh",
				'case "$1" in',
				"  list)",
				"    printf 'PID\\tStatus\\tLabel\\n-\\t0\\tcom.example.production\\n'",
				"    ;;",
				"  print-disabled)",
				"    printf 'disabled services = {}\\n'",
				"    ;;",
				"  *) exit 64 ;;",
				"esac",
				"",
			].join("\n"),
			{ mode: 0o700 },
		);
		chmodSync(launchctl, 0o700);
		const tmux = join(binRoot, "tmux");
		writeFileSync(tmux, "#!/bin/sh\nprintf 'production-session\\n'\n", {
			mode: 0o700,
		});
		chmodSync(tmux, 0o700);
		writeFileSync(join(productionRoot, "sentinel"), "production-unchanged\n", {
			mode: 0o600,
		});

		const legacyWriter = join(legacyRoot, "legacy-writer");
		writeFileSync(legacyWriter, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const githubLane = join(evidenceDir, "github-lane.json");
		writeFileSync(githubLane, '{"status":"pass"}\n', { mode: 0o600 });
		const commandMarkers = {
			stop: join(targetRoot, "command-stop.applied"),
			host: join(targetRoot, "command-host.applied"),
			bridge: join(targetRoot, "command-bridge.applied"),
			scheduler: join(targetRoot, "command-scheduler.applied"),
			lead: join(targetRoot, "command-lead.applied"),
		};

		const manifest = {
			v: 1,
			mode: "rehearsal",
			windowId: "fly1502-isolated-rehearsal",
			epoch: 1502,
			homeRoot,
			productionHomeRoot: productionRoot,
			ledgerDir: join(stateRoot, "ledger"),
			evidenceDir,
			rehearsalEvidencePath: join(evidenceDir, "rehearsal-pass.json"),
			database: {
				finalPath: join(stateRoot, "flywheel-v2.db"),
				markerPath: join(stateRoot, "migration-complete.json"),
				authorityPath: join(stateRoot, "cutover-authority.json"),
				armedPath: join(stateRoot, "cutover-armed.json"),
				rollbackReceiptPath: join(stateRoot, "rollback-receipt.json"),
			},
			legacy: {
				authoritativeLiveLeadIds: [],
				commDatabases: [],
				jsonInboxRoots: [],
				journalDatabases: [],
				tombstonePaths: [legacyWriter],
				writerProcessPatterns: [],
				launchdLabels: ["com.flywheel-rehearsal.bridge"],
				plistPaths: [],
				stopCommands: [
					{
						apply: [
							"/bin/sh",
							"-c",
							': > "$1"',
							"stop-legacy",
							commandMarkers.stop,
							"com.flywheel-rehearsal.bridge",
						],
						verify: ["/bin/test", "-f", commandMarkers.stop],
					},
				],
				credentialProbeCommands: [
					["/bin/sh", "-c", "echo unauthorized >&2; exit 77"],
				],
				liveFireCommands: [
					[
						"/bin/sh",
						"-c",
						'echo frozen >&2; printf x >> "$1"',
						"legacy-writer",
						legacyWriter,
					],
				],
				rollbackCommands: [
					{ apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				],
			},
			controlPlane: {
				launchdLabelPrefix: "com.flywheel-rehearsal.",
				plistDirectory: join(targetRoot, "launchd"),
				tmuxSocket: join(targetRoot, "tmux.sock"),
				cmuxTarget: "rehearsal-fly1502",
				wrapperPaths: [legacyWriter],
				credentialPaths: [],
				envKeys: ["FLYWHEEL_REHEARSAL_HOME"],
				startCommands: {
					host: {
						apply: [
							"/bin/sh",
							"-c",
							': > "$1"',
							"start-host",
							commandMarkers.host,
						],
						verify: ["/bin/test", "-f", commandMarkers.host],
					},
					bridge: {
						apply: [
							"/bin/sh",
							"-c",
							': > "$1"',
							"start-bridge",
							commandMarkers.bridge,
						],
						verify: ["/bin/test", "-f", commandMarkers.bridge],
					},
					scheduler: {
						apply: [
							"/bin/sh",
							"-c",
							': > "$1"',
							"start-scheduler",
							commandMarkers.scheduler,
						],
						verify: ["/bin/test", "-f", commandMarkers.scheduler],
					},
					leads: [
						{
							apply: [
								"/bin/sh",
								"-c",
								': > "$1"',
								"start-lead",
								commandMarkers.lead,
							],
							verify: ["/bin/test", "-f", commandMarkers.lead],
						},
					],
				},
			},
			founderConfirmations: {
				heldStart: "held-fly1502",
				finalGo: "go-fly1502",
			},
			githubLaneEvidencePath: githubLane,
		};
		const manifestPath = join(targetRoot, "target.json");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
			mode: 0o600,
		});

		const result = spawnSync(
			"/bin/bash",
			[join(REPO_ROOT, "scripts/rehearse-v2-cutover.sh"), manifestPath],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				timeout: 120_000,
				env: {
					...process.env,
					PATH: `${binRoot}:${process.env.PATH ?? ""}`,
				},
			},
		);
		assert.equal(
			result.status,
			0,
			[
				`stdout:\n${result.stdout}`,
				`stderr:\n${result.stderr}`,
				`signal: ${result.signal ?? "none"}`,
				`error: ${result.error?.stack ?? "none"}`,
				`ledger:\n${
					existsSync(join(stateRoot, "ledger", "ledger.jsonl"))
						? readFileSync(join(stateRoot, "ledger", "ledger.jsonl"), "utf8")
						: "missing"
				}`,
			].join("\n"),
		);

		const evidence = JSON.parse(
			readFileSync(manifest.rehearsalEvidencePath, "utf8"),
		);
		const finalGoNoGo = JSON.parse(
			readFileSync(join(evidenceDir, "go-no-go-final.json"), "utf8"),
		);
		const ledger = readFileSync(
			join(stateRoot, "ledger", "ledger.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(evidence.status, "pass");
		assert.equal(evidence.production_unchanged, true);
		assert.equal(finalGoNoGo.status, "go");
		assert.deepEqual(
			ledger
				.filter(
					(entry) =>
						entry.payload.kind === "step" && entry.payload.status === "done",
				)
				.map((entry) => entry.payload.step),
			[1, 2, 3, 4, 5, 6, 7, 8, 9],
		);
	} finally {
		try {
			chmodSync(join(targetRoot, "legacy"), 0o700);
		} catch {
			// The cutover may fail before the legacy namespace exists.
		}
		rmSync(targetRoot, { recursive: true, force: true });
		rmSync(productionRoot, { recursive: true, force: true });
	}
});
