#!/usr/bin/env node
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	admitIssueDag,
	approveShipGate,
	executeShip,
	reconcileShipActions,
	recordEvidence,
	submitNodeCompletion,
} from "flywheel-v2-dag";
import {
	publishSessionProof,
	readProcessStartIdentity,
} from "flywheel-v2-host";
import {
	type CutoverAuthorityState,
	openExistingKernel,
} from "flywheel-v2-kernel";
import { V2Client } from "./client.js";
import { createOperationalDagPorts } from "./dag-ports.js";
import { GhCliLanePort, probeGitHubLane } from "./github-lane.js";

type Verb =
	| "health"
	| "register-lead"
	| "enqueue"
	| "next"
	| "submit"
	| "admit"
	| "complete"
	| "evidence"
	| "approve-ship"
	| "ship"
	| "reconcile-ship"
	| "status"
	| "probe-github-lane";

interface ParsedCli {
	verb: Verb;
	socketPath?: string;
	secretPath?: string;
	values: Map<string, string>;
}

const VERBS = new Set<Verb>([
	"health",
	"register-lead",
	"enqueue",
	"next",
	"submit",
	"admit",
	"complete",
	"evidence",
	"approve-ship",
	"ship",
	"reconcile-ship",
	"status",
	"probe-github-lane",
]);

const COMMON = new Set(["--socket", "--secret"]);
const DATABASE_COMMON = new Set([
	"--db",
	"--marker",
	"--authority",
	"--armed",
	"--window",
	"--epoch",
	"--host-epoch",
	"--lock-root",
	"--git-bin",
	"--gh-bin",
]);
const DIRECT_VERBS = new Set<Verb>([
	"admit",
	"complete",
	"evidence",
	"approve-ship",
	"ship",
	"reconcile-ship",
	"status",
]);
const VERB_FLAGS: Record<Verb, ReadonlySet<string>> = {
	health: new Set(),
	"register-lead": new Set([
		"--agent",
		"--instance",
		"--host-epoch",
		"--session-id",
		"--session-proof-root",
		"--pid",
		"--pid-start",
	]),
	enqueue: new Set([
		"--source-kind",
		"--source-id",
		"--payload",
		"--to-agent",
		"--kind",
		"--retention",
	]),
	next: new Set(["--agent"]),
	submit: new Set([
		"--agent",
		"--attempt",
		"--message",
		"--capability-id",
		"--token",
		"--effects-file",
	]),
	admit: new Set(["--request-file"]),
	complete: new Set(["--request-file"]),
	evidence: new Set(["--request-file"]),
	"approve-ship": new Set(["--request-file"]),
	ship: new Set(["--request-file"]),
	"reconcile-ship": new Set(),
	status: new Set(),
	"probe-github-lane": new Set([
		"--repo",
		"--branch",
		"--output",
		"--gh-bin",
		"--policy-gh-config-dir",
	]),
};

function requireValue(values: Map<string, string>, flag: string): string {
	const value = values.get(flag);
	if (!value) throw new TypeError(`${flag} is required`);
	return value;
}

function requireAbsolute(values: Map<string, string>, flag: string): string {
	const value = requireValue(values, flag);
	if (!isAbsolute(value)) throw new TypeError(`${flag} must be absolute`);
	return value;
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
	const verb = argv[0] as Verb | undefined;
	if (!verb || !VERBS.has(verb)) {
		throw new TypeError("first argument is not a supported flywheel-v2 verb");
	}
	const values = new Map<string, string>();
	const allowed =
		verb === "probe-github-lane"
			? new Set(VERB_FLAGS[verb])
			: DIRECT_VERBS.has(verb)
				? new Set([...DATABASE_COMMON, ...VERB_FLAGS[verb]])
				: new Set([...COMMON, ...VERB_FLAGS[verb]]);
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index]!;
		if (!allowed.has(flag))
			throw new TypeError(`unknown ${verb} option ${flag}`);
		if (values.has(flag)) throw new TypeError(`duplicate option ${flag}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) {
			throw new TypeError(`${flag} requires a value`);
		}
		values.set(flag, value);
	}
	if (DIRECT_VERBS.has(verb)) {
		for (const flag of [
			"--db",
			"--marker",
			"--authority",
			"--armed",
		] as const) {
			requireAbsolute(values, flag);
		}
		requireValue(values, "--window");
		parsePositiveInteger(requireValue(values, "--epoch"), "--epoch");
		if (verb !== "status") {
			requireValue(values, "--host-epoch");
			requireAbsolute(values, "--lock-root");
		}
		if (verb !== "status" && verb !== "reconcile-ship") {
			requireAbsolute(values, "--request-file");
		}
	}
	return {
		verb,
		...(verb === "probe-github-lane" || DIRECT_VERBS.has(verb)
			? {}
			: {
					socketPath: requireAbsolute(values, "--socket"),
					secretPath: requireAbsolute(values, "--secret"),
				}),
		values,
	};
}

function parsePositiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed <= 0 ||
		String(parsed) !== value
	) {
		throw new TypeError(`${name} must be a canonical positive integer`);
	}
	return parsed;
}

function parseEffectsFile(path: string): unknown[] {
	if (!isAbsolute(path)) throw new TypeError("--effects-file must be absolute");
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(value)) {
		throw new TypeError("--effects-file must contain a JSON array");
	}
	return value;
}

function parseJsonFile(path: string, flag = "--request-file"): unknown {
	if (!isAbsolute(path)) throw new TypeError(`${flag} must be absolute`);
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function databaseOptions(
	values: Map<string, string>,
	allowedAuthorityStates: readonly CutoverAuthorityState[],
) {
	return {
		dbPath: requireAbsolute(values, "--db"),
		markerPath: requireAbsolute(values, "--marker"),
		authorityPath: requireAbsolute(values, "--authority"),
		armedPath: requireAbsolute(values, "--armed"),
		expectedWindowId: requireValue(values, "--window"),
		expectedEpoch: parsePositiveInteger(
			requireValue(values, "--epoch"),
			"--epoch",
		),
		allowedAuthorityStates,
	};
}

async function runDirectVerb(parsed: ParsedCli): Promise<unknown> {
	const allowed: readonly CutoverAuthorityState[] =
		parsed.verb === "status" ? ["cutover", "live"] : ["live"];
	const contract = databaseOptions(parsed.values, allowed);
	const kernel = openExistingKernel(contract);
	try {
		if (parsed.verb === "status") {
			return kernel.read((tx) => ({
				status: tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='cutover_authority_state'",
				)?.value,
				windowId: contract.expectedWindowId,
				epoch: contract.expectedEpoch,
				mailboxPending:
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM mailbox WHERE state='pending'",
					)?.count ?? 0,
				activeAttempts:
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM attempts WHERE desired_state <> 'terminal'",
					)?.count ?? 0,
				intendedActions:
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM actions WHERE state='intended'",
					)?.count ?? 0,
			}));
		}
		const ports = createOperationalDagPorts({
			gitBin: parsed.values.get("--git-bin"),
			ghBin: parsed.values.get("--gh-bin"),
			hostEpoch: requireValue(parsed.values, "--host-epoch"),
			lockRoot: requireAbsolute(parsed.values, "--lock-root"),
		});
		const request =
			parsed.verb === "reconcile-ship"
				? undefined
				: parseJsonFile(requireAbsolute(parsed.values, "--request-file"));
		switch (parsed.verb) {
			case "admit":
				return await admitIssueDag(
					kernel,
					ports,
					request as Parameters<typeof admitIssueDag>[2],
				);
			case "complete":
				return await submitNodeCompletion(
					kernel,
					ports,
					request as Parameters<typeof submitNodeCompletion>[2],
				);
			case "evidence":
				recordEvidence(
					kernel,
					ports,
					request as Parameters<typeof recordEvidence>[2],
				);
				return { status: "recorded" };
			case "approve-ship":
				return approveShipGate(
					kernel,
					ports,
					request as Parameters<typeof approveShipGate>[2],
				);
			case "ship":
				return await executeShip(
					kernel,
					ports,
					request as Parameters<typeof executeShip>[2],
				);
			case "reconcile-ship":
				return await reconcileShipActions(kernel, ports);
			default:
				throw new TypeError(`unsupported direct verb ${parsed.verb}`);
		}
	} finally {
		kernel.close();
	}
}

function publishEvidence(path: string, value: unknown): void {
	if (!isAbsolute(path)) throw new TypeError("--output must be absolute");
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const temporary = join(
		parent,
		`.github-lane-${process.pid}-${Date.now()}.tmp`,
	);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const parsed = parseCliArgs(argv);
	if (parsed.verb === "probe-github-lane") {
		const policyGhConfigDir = parsed.values.get("--policy-gh-config-dir");
		if (policyGhConfigDir !== undefined && !isAbsolute(policyGhConfigDir)) {
			throw new TypeError("--policy-gh-config-dir must be absolute");
		}
		const result = await probeGitHubLane(
			new GhCliLanePort(
				parsed.values.get("--gh-bin") ?? "gh",
				policyGhConfigDir,
			),
			{
				repo: requireValue(parsed.values, "--repo"),
				branch: requireValue(parsed.values, "--branch"),
				observedAt: new Date().toISOString(),
			},
		);
		publishEvidence(requireAbsolute(parsed.values, "--output"), result);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return result.status === "pass" ? 0 : 1;
	}
	if (DIRECT_VERBS.has(parsed.verb)) {
		const result = await runDirectVerb(parsed);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	}
	if (!parsed.socketPath || !parsed.secretPath) {
		throw new Error("host IPC paths are missing");
	}
	const client = new V2Client({
		socketPath: parsed.socketPath,
		secretPath: parsed.secretPath,
	});
	let result: unknown;
	switch (parsed.verb) {
		case "health":
			result = await client.request("health", {});
			break;
		case "register-lead": {
			const pid = parsePositiveInteger(
				requireValue(parsed.values, "--pid"),
				"--pid",
			);
			const observedStart = readProcessStartIdentity(pid);
			const requestedStart = parsed.values.get("--pid-start") ?? observedStart;
			if (!observedStart || requestedStart !== observedStart) {
				throw new Error("requested PID start identity is not live");
			}
			const sessionId = requireValue(parsed.values, "--session-id");
			publishSessionProof({
				root: requireAbsolute(parsed.values, "--session-proof-root"),
				sessionId,
				pid,
				pidStart: requestedStart,
			});
			result = await client.request("register_lead", {
				agentId: requireValue(parsed.values, "--agent"),
				instanceId: requireValue(parsed.values, "--instance"),
				sessionBinding: {
					v: 1,
					hostEpoch: requireValue(parsed.values, "--host-epoch"),
					sessionId,
					pid,
					pidStart: requestedStart,
				},
			});
			break;
		}
		case "enqueue":
			result = await client.request("enqueue", {
				sourceKind: requireValue(parsed.values, "--source-kind"),
				sourceId: requireValue(parsed.values, "--source-id"),
				payload: requireValue(parsed.values, "--payload"),
				toAgent: requireValue(parsed.values, "--to-agent"),
				kind: requireValue(parsed.values, "--kind"),
				retentionClass: requireValue(parsed.values, "--retention"),
			});
			break;
		case "next":
			result = await client.request("next_delivery", {
				agentId: requireValue(parsed.values, "--agent"),
			});
			break;
		case "submit":
			result = await client.submitProposalWithRetry({
				agentId: requireValue(parsed.values, "--agent"),
				attemptUid: requireValue(parsed.values, "--attempt"),
				messageUid: requireValue(parsed.values, "--message"),
				effects: parseEffectsFile(
					requireAbsolute(parsed.values, "--effects-file"),
				),
				authorization: {
					capabilityId: requireValue(parsed.values, "--capability-id"),
					token: requireValue(parsed.values, "--token"),
				},
			});
			break;
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return 0;
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined;
if (invokedPath === import.meta.url) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
