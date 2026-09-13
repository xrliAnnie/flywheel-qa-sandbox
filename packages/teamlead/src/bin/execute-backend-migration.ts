#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	assertMigrationWriterStopped,
	loadMigrationReceipt,
	type MigrationObservation,
	observeMigrationArtifact,
	observeMigrationRegistry,
	parseMigrationWindowContext,
	readMigrationIntentRecord,
	readMigrationRegistry,
	renderMigrationArtifacts,
	resolveMigrationIdentities,
} from "flywheel-comm/lead-backend-migration-runtime";
import {
	observeMigrationActivation,
	observeMigrationSource,
} from "./backend-migration-activation.js";
import {
	createMigrationWindowGuard,
	readMigrationDeploymentHead,
} from "./backend-migration-authority.js";
import { runMigrationStaticPreflight } from "./backend-migration-lifecycle.js";
import { runBackendMigrationWindow } from "./backend-migration-window.js";
import {
	collectAndSeedBackendMigration,
	observeBackendMigrationSeed,
} from "./collect-seed-backend-migration.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Internal entry: invoked only by the source-only helper in the existing wave. */
export async function executeMigrationEntry(
	json: string,
	trusted = {
		home: homedir(),
		root: realpathSync(fileURLToPath(new URL("../../../../", import.meta.url))),
	},
) {
	parseMigrationWindowContext(json, trusted);
	const { home, root } = trusted;
	const intentPath = join(
		home,
		".flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json",
	);
	const { plan, intentSha } = readMigrationIntentRecord(home, intentPath);
	const windowGuard = createMigrationWindowGuard(
		json,
		trusted,
		plan.deploymentSha,
	);
	const assertWindow = () => {
		windowGuard();
		if (readMigrationIntentRecord(home, intentPath).intentSha !== intentSha)
			throw Error("migration intent changed");
	};
	// Inspection is bound to this wave's actual checkout and owner, while all
	// migration mutations below remain bound to the intent's exact deployment.
	const currentSha = readMigrationDeploymentHead(root);
	const inspectGuard = createMigrationWindowGuard(json, trusted, currentSha);
	const inspectWindow = () => {
		inspectGuard();
		if (readMigrationIntentRecord(home, intentPath).intentSha !== intentSha)
			throw Error("migration intent changed");
	};
	inspectWindow();
	const registry = readMigrationRegistry(home);
	const identities = resolveMigrationIdentities(home, registry, plan);
	const target = renderMigrationArtifacts(home, registry, plan);
	const uid = process.getuid?.();
	if (uid === undefined) throw Error("migration requires host uid");
	const oldCarrier = () => {
		const value = loadMigrationReceipt(home)?.sourceCarrier;
		if (!value) throw Error("migration source carrier missing");
		return value;
	};
	const stopped = () =>
		assertMigrationWriterStopped({
			dbPath: join(home, ".flywheel/lead-lease.db"),
			oldCarrier: oldCarrier(),
			assertWindow,
			launchdState: () => {
				try {
					const helper = join(root, "scripts/lib/lead-restart-lifecycle.sh"),
						stat = lstatSync(helper);
					if (!stat.isFile() || stat.isSymbolicLink()) return "error";
					const output = execFileSync(
						"/bin/bash",
						[
							"-c",
							'source "$1" || exit $?; lead_restart_launchd_probe "$2"',
							"migration-stop-probe",
							helper,
							`gui/${uid}/com.flywheel.lead.flywheel-flywheel-product-lead`,
						],
						{
							encoding: "utf8",
							timeout: 3000,
							maxBuffer: 1024,
							stdio: ["ignore", "pipe", "ignore"],
						},
					).trim();
					return output === "unloaded"
						? "unloaded"
						: /^loaded\t\d+$/.test(output)
							? "loaded"
							: "error";
				} catch {
					return "error";
				}
			},
		});
	const assertStopped = () => {
		stopped();
	};
	const source = (guard = assertWindow) =>
		observeMigrationSource({
			home,
			uid,
			plan,
			target,
			identityDigest: identities.source.identityDigest,
			assertWindow: guard,
			assertStopped,
		});
	const active = async (guard = assertWindow) => {
		guard();
		if (observeMigrationRegistry(home, plan).state !== "post")
			throw Error("migration target registry unproven");
		for (const kind of ["manifest", "plist"] as const)
			if (
				observeMigrationArtifact(
					home,
					plan.expected,
					kind,
					target[kind],
					assertStopped,
				).state !== "post"
			)
				throw Error("migration target artifact unproven");
		return observeMigrationActivation({
			home,
			root,
			uid,
			identityDigest: identities.target.identityDigest,
			oldCarrier: oldCarrier(),
			assertWindow: guard,
		});
	};
	const waitActive = async () => {
		const deadline = Date.now() + 20000;
		for (;;) {
			assertWindow();
			try {
				return await active();
			} catch (error) {
				if (Date.now() >= deadline) throw error;
			}
			await delay(250);
		}
	};
	const prior = loadMigrationReceipt(home);
	if (prior && prior.intentSha !== intentSha)
		throw Error("migration receipt intent conflict");
	const skip = (
		reason: "source_unchanged" | "source_restored" | "awaiting_verification",
	) => {
		inspectWindow();
		if (JSON.stringify(loadMigrationReceipt(home)) !== JSON.stringify(prior))
			throw Error("migration receipt changed during inspection");
		return { status: "skipped" as const, reason, intentSha };
	};
	// A completed migration awaits the separate verifier. Never replay its
	// stop/seed/activation or suppress the ordinary restart in a later wave.
	if (
		prior &&
		["deployed_unverified", "verified", "committed"].includes(prior.status) &&
		prior.pending === null &&
		!prior.recovery
	) {
		await active(inspectWindow);
		return skip("awaiting_verification");
	}
	if (
		prior?.status === "failed" &&
		prior.pending === null &&
		prior.recovery?.state === "restored"
	) {
		if (!(await source(inspectWindow)))
			throw Error("migration restored source unproven");
		return skip("source_restored");
	}
	const untouched =
		!prior ||
		(!prior.recovery &&
			!prior.sourceCarrier &&
			(prior.pending === null || prior.pending === "preflight") &&
			Object.keys(prior.completed).every((step) => step === "preflight"));
	if (
		untouched &&
		(currentSha !== plan.deploymentSha || prior?.status === "held")
	) {
		if (!(await source(inspectWindow)))
			throw Error("migration unchanged source unproven");
		return skip("source_unchanged");
	}
	// Partial/unknown transitions never acquire mutation authority on another SHA.
	assertWindow();
	let prepared:
		| Awaited<ReturnType<typeof runMigrationStaticPreflight>>
		| undefined;
	const prepare = async () => {
		const next = await runMigrationStaticPreflight({
			home,
			root,
			projectRoot: identities.projectRoot,
			deploymentSha: plan.deploymentSha,
			botTokenEnv: identities.botTokenEnv,
			assertWindow,
		});
		if (prepared && JSON.stringify(prepared) !== JSON.stringify(next))
			throw Error("migration resolved paths changed");
		prepared = next;
	};
	const seedInput = () => {
		if (!prepared) throw Error("migration target paths unprepared");
		return {
			home,
			stateDir: prepared.stateDir,
			intentSha,
			botUserId: identities.botUserId,
			channelIds: identities.channelIds,
		};
	};
	const result = await runBackendMigrationWindow({
		home,
		root,
		intentSha,
		plan,
		target,
		assertWindow,
		assertStopped,
		validateCandidate: (path) => {
			try {
				execFileSync(
					process.execPath,
					[join(root, "packages/teamlead/dist/bin/validate-projects.js"), path],
					{
						timeout: 10000,
						maxBuffer: 65536,
						stdio: ["ignore", "pipe", "ignore"],
					},
				);
			} catch {
				throw Error("migration registry candidate invalid");
			}
		},
		captureSourceCarrier: async () => {
			const observed = await source();
			if (!observed) throw Error("migration source owner unproven");
			return { pid: observed.carrier.pid, start: observed.carrier.start };
		},
		staticPreflight: prepare,
		seed: async () => {
			const botToken = process.env[identities.botTokenEnv];
			if (!botToken) throw Error("migration bot token unavailable");
			await collectAndSeedBackendMigration({
				...seedInput(),
				botToken,
				assertWindowAndStopped: assertStopped,
			});
		},
		observe: async (step): Promise<MigrationObservation> => {
			assertWindow();
			switch (step) {
				case "preflight":
					if (!prepared && loadMigrationReceipt(home)?.completed.preflight)
						await prepare();
					return {
						state: prepared ? "post" : "pre",
						proofSha: hash(prepared ?? "unprepared"),
					};
				case "stop": {
					try {
						return { state: "post", proofSha: stopped() };
					} catch {
						assertWindow();
					}
					const current = await source();
					if (current) {
						const old = oldCarrier();
						if (
							current.carrier.pid !== old.pid ||
							current.carrier.start !== old.start
						)
							throw Error("migration source owner changed");
						return { state: "pre", proofSha: current.proofSha };
					}
					// The stop remains proved after activation by the original tuple being
					// dead and the exact new owner being live, not by an unloaded current job.
					return { state: "post", proofSha: await waitActive() };
				}
				case "configure":
					return observeMigrationRegistry(home, plan);
				case "stage_manifest":
				case "stage_plist": {
					const kind = step === "stage_manifest" ? "manifest" : "plist";
					return observeMigrationArtifact(
						home,
						plan.expected,
						kind,
						target[kind],
						assertStopped,
					);
				}
				case "seed":
					return observeBackendMigrationSeed(seedInput());
				case "activate":
					try {
						return { state: "pre", proofSha: stopped() };
					} catch {
						assertWindow();
					}
					return { state: "post", proofSha: await waitActive() };
			}
		},
		observeRestoredSource: async () => {
			const result = await source();
			return result?.proofSha ?? null;
		},
	});
	if (result.status === "failed" && result.recovery?.state === "restored") {
		if (!(await source())) throw Error("migration restored source unproven");
		assertWindow();
		return {
			status: "skipped" as const,
			reason: "source_restored" as const,
			intentSha,
		};
	}
	return result;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	if (argv.length !== 2 || argv[0] !== "--window-context" || !argv[1]) {
		process.stderr.write("migration requires --window-context\n");
		return 64;
	}
	try {
		const receipt = await executeMigrationEntry(argv[1]);
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		return receipt.status === "deployed_unverified" ||
			receipt.status === "skipped"
			? 0
			: 78;
	} catch {
		process.stderr.write(
			"migration held; inspect the execution receipt and restart log\n",
		);
		return 78;
	}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	void main().then((code) => {
		process.exitCode = code;
	});
