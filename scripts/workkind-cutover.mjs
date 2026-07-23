#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "fly-1436-cutover-v1";
const ROUTE = "/api/workflow/cutovers/FLY-1436";
const STATE_FILE = "FLY-1436.json";

const USAGE = `Usage:
  node scripts/workkind-cutover.mjs version
  node scripts/workkind-cutover.mjs status
  node scripts/workkind-cutover.mjs stage activate [--operation-id <id>] [--output <private-json>]
  node scripts/workkind-cutover.mjs stage restore --source-operation-id <id> --snapshot <json> [--operation-id <id>] [--output <private-json>]
  node scripts/workkind-cutover.mjs apply --input <private-stage-json>

Environment:
  TEAMLEAD_API_TOKEN   required for stage/apply; never accepted on argv
  FLYWHEEL_BRIDGE_URL  defaults to http://127.0.0.1:9876`;

class CliError extends Error {
	constructor(message, code = 2) {
		super(message);
		this.code = code;
	}
}

function parseOptions(args, allowed) {
	const values = {};
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (!flag.startsWith("--") || !allowed.has(flag)) {
			throw new CliError(`unknown argument: ${flag}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) {
			throw new CliError(`missing value for ${flag}`);
		}
		if (Object.hasOwn(values, flag)) {
			throw new CliError(`duplicate argument: ${flag}`);
		}
		values[flag] = value;
		index += 1;
	}
	return values;
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CliError(`${label} is not readable JSON: ${error.message}`);
	}
}

function ensurePrivateDirectory(path, hardenExisting = false) {
	const created = mkdirSync(path, { recursive: true, mode: 0o700 });
	if (created !== undefined || hardenExisting) chmodSync(path, 0o700);
}

function rejectSymlink(path) {
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new CliError(`refusing symlink target: ${path}`);
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error.code !== "ENOENT") throw error;
	}
}

function atomicWriteJson(path, value) {
	const parent = dirname(path);
	ensurePrivateDirectory(parent);
	rejectSymlink(path);
	const temporary = join(
		parent,
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temp file either never existed or was already renamed.
		}
		throw error;
	}
}

function assertRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CliError(`${label} is invalid`);
	}
	return value;
}

async function postBridge(fetchImpl, bridgeUrl, apiToken, action, body) {
	let response;
	try {
		response = await fetchImpl(`${bridgeUrl}${ROUTE}/${action}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new CliError(`Bridge request failed: ${error.message}`, 1);
	}
	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new CliError(`Bridge returned non-JSON HTTP ${response.status}`, 1);
	}
	if (!response.ok) {
		throw new CliError(
			`Bridge rejected HTTP ${response.status}: ${JSON.stringify(payload)}`,
			1,
		);
	}
	return assertRecord(payload, "Bridge response");
}

function operationState(canonical, phase, snapshotPath, prior) {
	return {
		phase,
		mergeSha:
			canonical.expected?.deployedSha ??
			(typeof prior?.mergeSha === "string" ? prior.mergeSha : null),
		operationId: canonical.operationId,
		activationOperationId:
			canonical.kind === "activate"
				? canonical.operationId
				: (prior?.activationOperationId ??
					prior?.operationId ??
					canonical.sourceOperationId ??
					null),
		snapshotPath: snapshotPath ?? prior?.snapshotPath ?? null,
		snapshotHash: canonical.snapshotHash,
	};
}

/**
 * Thin HTTP client for the server-owned FLY-1436 cutover authority.
 * Dependency injection keeps tests off the network and outside the real state dir.
 */
export async function runWorkKindCutoverCli(argv, dependencies = {}) {
	const env = dependencies.env ?? process.env;
	const fetchImpl = dependencies.fetchImpl ?? fetch;
	const stateRoot =
		dependencies.stateRoot ?? join(homedir(), ".flywheel", "state", "cutovers");
	const now = dependencies.now ?? (() => new Date().toISOString());
	const io = dependencies.io ?? {
		stdout: (line) => process.stdout.write(`${line}\n`),
		stderr: (line) => process.stderr.write(`${line}\n`),
	};
	const statePath = join(stateRoot, STATE_FILE);

	try {
		const [command, ...rest] = argv;
		if (!command || command === "--help" || command === "help") {
			io.stdout(USAGE);
			return command ? 0 : 2;
		}
		if (command === "version" || command === "--version") {
			io.stdout(VERSION);
			return 0;
		}
		if (command === "status") {
			if (rest.length > 0) throw new CliError("status takes no arguments");
			io.stdout(JSON.stringify(readJson(statePath, "cutover state"), null, 2));
			return 0;
		}

		const apiToken = env.TEAMLEAD_API_TOKEN;
		if (!apiToken) {
			throw new CliError(
				"TEAMLEAD_API_TOKEN is required for stage/apply and is never accepted on argv",
			);
		}
		// stateRoot is tool-owned; unlike an operator-selected --output parent,
		// an existing permissive stateRoot should be tightened deliberately.
		ensurePrivateDirectory(stateRoot, true);
		const bridgeUrl = (
			env.FLYWHEEL_BRIDGE_URL ??
			env.BRIDGE_URL ??
			"http://127.0.0.1:9876"
		).replace(/\/+$/, "");

		if (command === "stage") {
			const [kind, ...optionArgs] = rest;
			if (kind !== "activate" && kind !== "restore") {
				throw new CliError("stage kind must be activate or restore");
			}
			const options = parseOptions(
				optionArgs,
				new Set([
					"--operation-id",
					"--output",
					"--source-operation-id",
					"--snapshot",
				]),
			);
			const request = {
				kind,
				...(options["--operation-id"]
					? { operationId: options["--operation-id"] }
					: {}),
			};
			let sourceSnapshotPath;
			if (kind === "restore") {
				if (!options["--source-operation-id"] || !options["--snapshot"]) {
					throw new CliError(
						"restore requires --source-operation-id and --snapshot",
					);
				}
				sourceSnapshotPath = resolve(options["--snapshot"]);
				request.sourceOperationId = options["--source-operation-id"];
				request.snapshot = readJson(sourceSnapshotPath, "restore snapshot");
			} else if (options["--source-operation-id"] || options["--snapshot"]) {
				throw new CliError(
					"activate does not accept --source-operation-id or --snapshot",
				);
			}

			const response = await postBridge(
				fetchImpl,
				bridgeUrl,
				apiToken,
				"stage",
				request,
			);
			const canonical = assertRecord(response.canonical, "canonical request");
			if (
				canonical.kind !== kind ||
				typeof canonical.operationId !== "string" ||
				typeof canonical.snapshotHash !== "string" ||
				typeof response.confirmToken !== "string"
			) {
				throw new CliError("Bridge stage response has an invalid shape", 1);
			}
			const stagePath = resolve(
				options["--output"] ??
					join(stateRoot, "staged", `${canonical.operationId}.json`),
			);
			let snapshotPath = sourceSnapshotPath;
			if (kind === "activate") {
				assertRecord(response.snapshot, "activation snapshot");
				snapshotPath = join(
					stateRoot,
					"snapshots",
					`${canonical.operationId}.json`,
				);
				atomicWriteJson(snapshotPath, response.snapshot);
			}
			let prior;
			try {
				prior = readJson(statePath, "cutover state");
			} catch {
				prior = undefined;
			}
			atomicWriteJson(stagePath, {
				canonical,
				confirmToken: response.confirmToken,
			});
			const state = {
				...operationState(canonical, `staged_${kind}`, snapshotPath, prior),
				updatedAt: now(),
			};
			atomicWriteJson(statePath, state);
			io.stdout(
				JSON.stringify({
					ok: true,
					kind,
					operationId: canonical.operationId,
					stagePath,
					snapshotPath,
					snapshotHash: canonical.snapshotHash,
				}),
			);
			return 0;
		}

		if (command === "apply") {
			const options = parseOptions(rest, new Set(["--input"]));
			if (!options["--input"]) {
				throw new CliError("apply requires --input");
			}
			const stagePath = resolve(options["--input"]);
			const staged = assertRecord(
				readJson(stagePath, "staged request"),
				"stage",
			);
			const canonical = assertRecord(staged.canonical, "canonical request");
			if (
				(canonical.kind !== "activate" && canonical.kind !== "restore") ||
				typeof canonical.operationId !== "string" ||
				typeof canonical.snapshotHash !== "string" ||
				typeof staged.confirmToken !== "string"
			) {
				throw new CliError("staged request has an invalid shape");
			}
			let prior;
			try {
				prior = readJson(statePath, "cutover state");
			} catch {
				prior = undefined;
			}
			const response = await postBridge(
				fetchImpl,
				bridgeUrl,
				apiToken,
				"apply",
				{
					canonical,
					confirmToken: staged.confirmToken,
				},
			);
			if (response.status !== "committed" && response.status !== "replayed") {
				throw new CliError("Bridge apply response has an invalid status", 1);
			}
			const state = {
				...operationState(
					canonical,
					canonical.kind === "activate" ? "activated" : "restored",
					undefined,
					prior,
				),
				updatedAt: now(),
			};
			atomicWriteJson(statePath, state);
			io.stdout(JSON.stringify(response));
			return 0;
		}

		throw new CliError(`unknown command: ${command}`);
	} catch (error) {
		const known = error instanceof CliError;
		io.stderr(known ? error.message : `unexpected error: ${error.message}`);
		return known ? error.code : 1;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	process.exitCode = await runWorkKindCutoverCli(process.argv.slice(2));
}
