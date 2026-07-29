import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

export interface CutoverTargetManifest {
	v: 1;
	mode: "rehearsal" | "production";
	windowId: string;
	epoch: number;
	homeRoot: string;
	productionHomeRoot: string;
	ledgerDir: string;
	evidenceDir: string;
	rehearsalEvidencePath: string;
	database: {
		finalPath: string;
		markerPath: string;
		authorityPath: string;
		armedPath: string;
		rollbackReceiptPath: string;
	};
	legacy: {
		/**
		 * Lead IDs captured from the authoritative pre-freeze Bridge registry.
		 * Session rows are only supplementary evidence because a Lead need not
		 * have dispatched a Runner.
		 */
		authoritativeLiveLeadIds: string[];
		/**
		 * StateStore database whose sessions table is the authoritative Runner
		 * execution registry. Rehearsals without Runner-addressed rows may omit it;
		 * production manifests must name it explicitly.
		 */
		runnerSessionDatabase?: string;
		commDatabases: string[];
		jsonInboxRoots: string[];
		journalDatabases: string[];
		tombstonePaths: string[];
		writerProcessPatterns: string[];
		launchdLabels: string[];
		plistPaths: string[];
		stopCommands: LedgeredCommand[];
		credentialProbeCommands: string[][];
		liveFireCommands: string[][];
		rollbackCommands: LedgeredCommand[];
	};
	controlPlane: {
		launchdLabelPrefix: string;
		plistDirectory: string;
		tmuxSocket: string;
		cmuxTarget: string;
		wrapperPaths: string[];
		credentialPaths: string[];
		envKeys: string[];
		startCommands: {
			host: LedgeredCommand;
			bridge: LedgeredCommand;
			scheduler: LedgeredCommand;
			leads: LedgeredCommand[];
		};
	};
	founderConfirmations: {
		heldStart: string;
		finalGo: string;
	};
	githubLaneEvidencePath: string;
}

export interface LedgeredCommand {
	/** Reconciliation-safe mutation command. */
	apply: string[];
	/** Read-only probe that exits zero only when the mutation is fully applied. */
	verify: string[];
}

function fail(message: string): never {
	throw new Error(`cutover target manifest invalid: ${message}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(`${name} must be a non-empty string`);
	}
	return value;
}

function path(value: unknown, name: string): string {
	const result = string(value, name);
	if (!isAbsolute(result)) fail(`${name} must be absolute`);
	const absolute = resolve(result);
	try {
		if (lstatSync(absolute).isSymbolicLink()) {
			fail(`${name} must not be a symbolic link`);
		}
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}
	let probe = absolute;
	const suffix: string[] = [];
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return absolute;
		suffix.unshift(basename(probe));
		probe = parent;
	}
	return join(realpathSync.native(probe), ...suffix);
}

function strings(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) fail(`${name} must be an array`);
	return value.map((entry, index) => string(entry, `${name}[${index}]`));
}

function paths(value: unknown, name: string): string[] {
	return strings(value, name).map((entry, index) =>
		path(entry, `${name}[${index}]`),
	);
}

function commands(value: unknown, name: string): string[][] {
	if (!Array.isArray(value)) fail(`${name} must be an array`);
	return value.map((entry, index) => {
		const command = strings(entry, `${name}[${index}]`);
		if (command.length === 0) fail(`${name}[${index}] must not be empty`);
		return command;
	});
}

function command(value: unknown, name: string): string[] {
	const result = strings(value, name);
	if (result.length === 0) fail(`${name} must not be empty`);
	return result;
}

function ledgeredCommand(value: unknown, name: string): LedgeredCommand {
	const input = object(value, name);
	return {
		apply: command(input.apply, `${name}.apply`),
		verify: command(input.verify, `${name}.verify`),
	};
}

function ledgeredCommands(value: unknown, name: string): LedgeredCommand[] {
	if (!Array.isArray(value)) fail(`${name} must be an array`);
	return value.map((entry, index) =>
		ledgeredCommand(entry, `${name}[${index}]`),
	);
}

function contains(parent: string, candidate: string): boolean {
	const rel = relative(resolve(parent), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertUniquePaths(values: string[], name: string): void {
	if (new Set(values).size !== values.length) {
		fail(`${name} contains duplicate paths`);
	}
}

function assertUniqueStrings(values: string[], name: string): void {
	if (new Set(values).size !== values.length) {
		fail(`${name} contains duplicates`);
	}
}

export function parseTargetManifest(value: unknown): CutoverTargetManifest {
	const input = object(value, "manifest");
	if (input.v !== 1) fail("v must equal 1");
	if (input.mode !== "rehearsal" && input.mode !== "production") {
		fail("mode must be rehearsal or production");
	}
	const epoch = input.epoch;
	if (!Number.isSafeInteger(epoch) || (epoch as number) <= 0) {
		fail("epoch must be a positive safe integer");
	}
	const databaseInput = object(input.database, "database");
	const legacyInput = object(input.legacy, "legacy");
	const controlInput = object(input.controlPlane, "controlPlane");
	const startInput = object(controlInput.startCommands, "startCommands");
	const confirmationInput = object(
		input.founderConfirmations,
		"founderConfirmations",
	);
	const manifest: CutoverTargetManifest = {
		v: 1,
		mode: input.mode,
		windowId: string(input.windowId, "windowId"),
		epoch: epoch as number,
		homeRoot: path(input.homeRoot, "homeRoot"),
		productionHomeRoot: path(input.productionHomeRoot, "productionHomeRoot"),
		ledgerDir: path(input.ledgerDir, "ledgerDir"),
		evidenceDir: path(input.evidenceDir, "evidenceDir"),
		rehearsalEvidencePath: path(
			input.rehearsalEvidencePath,
			"rehearsalEvidencePath",
		),
		database: {
			finalPath: path(databaseInput.finalPath, "database.finalPath"),
			markerPath: path(databaseInput.markerPath, "database.markerPath"),
			authorityPath: path(
				databaseInput.authorityPath,
				"database.authorityPath",
			),
			armedPath: path(databaseInput.armedPath, "database.armedPath"),
			rollbackReceiptPath: path(
				databaseInput.rollbackReceiptPath,
				"database.rollbackReceiptPath",
			),
		},
		legacy: {
			authoritativeLiveLeadIds: strings(
				legacyInput.authoritativeLiveLeadIds,
				"legacy.authoritativeLiveLeadIds",
			),
			...(legacyInput.runnerSessionDatabase === undefined
				? {}
				: {
						runnerSessionDatabase: path(
							legacyInput.runnerSessionDatabase,
							"legacy.runnerSessionDatabase",
						),
					}),
			commDatabases: paths(legacyInput.commDatabases, "legacy.commDatabases"),
			jsonInboxRoots: paths(
				legacyInput.jsonInboxRoots,
				"legacy.jsonInboxRoots",
			),
			journalDatabases: paths(
				legacyInput.journalDatabases,
				"legacy.journalDatabases",
			),
			tombstonePaths: paths(
				legacyInput.tombstonePaths,
				"legacy.tombstonePaths",
			),
			writerProcessPatterns: strings(
				legacyInput.writerProcessPatterns,
				"legacy.writerProcessPatterns",
			),
			launchdLabels: strings(legacyInput.launchdLabels, "legacy.launchdLabels"),
			plistPaths: paths(legacyInput.plistPaths, "legacy.plistPaths"),
			stopCommands: ledgeredCommands(
				legacyInput.stopCommands ?? [],
				"legacy.stopCommands",
			),
			credentialProbeCommands: commands(
				legacyInput.credentialProbeCommands ?? [],
				"legacy.credentialProbeCommands",
			),
			liveFireCommands: commands(
				legacyInput.liveFireCommands ?? [],
				"legacy.liveFireCommands",
			),
			rollbackCommands: ledgeredCommands(
				legacyInput.rollbackCommands ?? [],
				"legacy.rollbackCommands",
			),
		},
		controlPlane: {
			launchdLabelPrefix: string(
				controlInput.launchdLabelPrefix,
				"controlPlane.launchdLabelPrefix",
			),
			plistDirectory: path(
				controlInput.plistDirectory,
				"controlPlane.plistDirectory",
			),
			tmuxSocket: path(controlInput.tmuxSocket, "controlPlane.tmuxSocket"),
			cmuxTarget: string(controlInput.cmuxTarget, "controlPlane.cmuxTarget"),
			wrapperPaths: paths(
				controlInput.wrapperPaths,
				"controlPlane.wrapperPaths",
			),
			credentialPaths: paths(
				controlInput.credentialPaths,
				"controlPlane.credentialPaths",
			),
			envKeys: strings(controlInput.envKeys, "controlPlane.envKeys"),
			startCommands: {
				host: ledgeredCommand(startInput.host, "startCommands.host"),
				bridge: ledgeredCommand(startInput.bridge, "startCommands.bridge"),
				scheduler: ledgeredCommand(
					startInput.scheduler,
					"startCommands.scheduler",
				),
				leads: ledgeredCommands(startInput.leads, "startCommands.leads"),
			},
		},
		founderConfirmations: {
			heldStart: string(
				confirmationInput.heldStart,
				"founderConfirmations.heldStart",
			),
			finalGo: string(
				confirmationInput.finalGo,
				"founderConfirmations.finalGo",
			),
		},
		githubLaneEvidencePath: path(
			input.githubLaneEvidencePath,
			"githubLaneEvidencePath",
		),
	};

	const allPaths = [
		manifest.homeRoot,
		manifest.ledgerDir,
		manifest.evidenceDir,
		manifest.rehearsalEvidencePath,
		...Object.values(manifest.database),
		...(manifest.legacy.runnerSessionDatabase
			? [manifest.legacy.runnerSessionDatabase]
			: []),
		...manifest.legacy.commDatabases,
		...manifest.legacy.jsonInboxRoots,
		...manifest.legacy.journalDatabases,
		...manifest.legacy.tombstonePaths,
		...manifest.legacy.plistPaths,
		manifest.controlPlane.plistDirectory,
		manifest.controlPlane.tmuxSocket,
		...manifest.controlPlane.wrapperPaths,
		...manifest.controlPlane.credentialPaths,
		manifest.githubLaneEvidencePath,
	];
	assertUniquePaths(
		Object.values(manifest.database),
		"database authority paths",
	);
	assertUniqueStrings(
		manifest.legacy.authoritativeLiveLeadIds,
		"legacy.authoritativeLiveLeadIds",
	);
	if (
		manifest.mode === "production" &&
		manifest.legacy.runnerSessionDatabase === undefined
	) {
		fail("production requires legacy.runnerSessionDatabase");
	}
	if (
		manifest.legacy.runnerSessionDatabase &&
		manifest.legacy.commDatabases.includes(
			manifest.legacy.runnerSessionDatabase,
		)
	) {
		fail("Runner session database must be separate from legacy.commDatabases");
	}
	assertUniquePaths(manifest.legacy.tombstonePaths, "legacy tombstone paths");
	if (manifest.mode === "rehearsal") {
		const isolationRoot = resolve(manifest.homeRoot, "..");
		for (const candidate of allPaths) {
			if (
				contains(manifest.productionHomeRoot, candidate) ||
				!contains(isolationRoot, candidate)
			) {
				fail(`rehearsal isolation overlap for ${candidate}`);
			}
		}
		if (
			manifest.controlPlane.launchdLabelPrefix !== "com.flywheel-rehearsal." ||
			manifest.legacy.launchdLabels.some(
				(label) => !label.startsWith(manifest.controlPlane.launchdLabelPrefix),
			)
		) {
			fail("rehearsal isolation requires rehearsal launchd labels");
		}
		if (
			manifest.controlPlane.tmuxSocket === "default" ||
			!manifest.controlPlane.cmuxTarget.startsWith("rehearsal-")
		) {
			fail("rehearsal isolation requires namespaced tmux and cmux");
		}
	}
	const newPaths = [
		manifest.homeRoot,
		manifest.ledgerDir,
		manifest.evidenceDir,
		...Object.values(manifest.database),
		manifest.controlPlane.tmuxSocket,
		manifest.controlPlane.plistDirectory,
	];
	for (const fence of manifest.legacy.tombstonePaths) {
		for (const current of newPaths) {
			if (contains(fence, current) || contains(current, fence)) {
				fail(`tombstone path ${fence} overlaps new path ${current}`);
			}
		}
	}
	const oldWritePaths = [
		...(manifest.legacy.runnerSessionDatabase
			? [manifest.legacy.runnerSessionDatabase]
			: []),
		...manifest.legacy.commDatabases,
		...manifest.legacy.jsonInboxRoots,
		...manifest.legacy.journalDatabases,
		...manifest.legacy.plistPaths,
		...manifest.controlPlane.wrapperPaths,
		...manifest.controlPlane.credentialPaths,
	];
	for (const oldPath of oldWritePaths) {
		if (
			!manifest.legacy.tombstonePaths.some((fence) => contains(fence, oldPath))
		) {
			fail(`old writer path is not covered by a tombstone: ${oldPath}`);
		}
	}
	const stopCommandText = manifest.legacy.stopCommands
		.flatMap((entry) => entry.apply)
		.join("\n");
	for (const label of manifest.legacy.launchdLabels) {
		if (!stopCommandText.includes(label)) {
			fail(`launchd label has no stop command: ${label}`);
		}
	}
	if (
		manifest.legacy.stopCommands.length === 0 ||
		manifest.legacy.credentialProbeCommands.length === 0 ||
		manifest.legacy.liveFireCommands.length === 0 ||
		manifest.legacy.rollbackCommands.length === 0
	) {
		fail(
			"stop, credential probe, live-fire, and rollback commands are required",
		);
	}
	return manifest;
}
