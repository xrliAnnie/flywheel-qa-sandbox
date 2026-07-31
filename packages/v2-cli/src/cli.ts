#!/usr/bin/env node
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
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
	| "ask"
	| "next"
	| "submit"
	| "ack"
	| "mailbox-status"
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
	"ask",
	"next",
	"submit",
	"ack",
	"mailbox-status",
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
	// FLY-1543 ①: registration IS the takeover -- no --death-evidence-file; a
	// new registration displaces the old one directly.
	"register-lead": new Set([
		"--agent",
		"--instance",
		"--host-epoch",
		"--session-id",
		"--session-proof-root",
		"--pid",
		"--pid-start",
		// Codex R3 HIGH-2: where to keep the pull credential this registration is
		// handed. Given, the credential is written 0600 and redacted from stdout so
		// it does not reach a log.
		"--delivery-credential-out",
	]),
	enqueue: new Set([
		"--source-kind",
		"--source-id",
		"--payload",
		"--to-agent",
		"--kind",
		"--retention",
	]),
	// FLY-1543 ③: the runner->lead upstream verb. Deliberately NO --to-agent:
	// the recipient is resolved server-side from the session's issue, so a
	// runner cannot address arbitrary recipients.
	ask: new Set(["--session", "--ask-kind", "--payload", "--uid"]),
	// Codex R3 HIGH-2: a LEAD pull is authorised by the credential minted for its
	// registration. FLY-1543 ④: a RUNNER pulls its own session mailbox with
	// --session (the active activation is the registration).
	next: new Set(["--agent", "--delivery-credential-file", "--session"]),
	submit: new Set([
		"--agent",
		"--attempt",
		"--message",
		"--capability-id",
		"--token",
		"--effects-file",
	]),
	// FLY-1544 ③: the lead-consumption settle verb. A pulled delivery that
	// needs no effects (a notification the lead has read) is settled with an
	// EMPTY proposal -- same one-shot settlement path as submit, so the mailbox
	// row goes applied and is never silently redelivered.
	ack: new Set([
		"--agent",
		"--attempt",
		"--message",
		"--capability-id",
		"--token",
	]),
	admit: new Set(["--request-file"]),
	complete: new Set(["--request-file"]),
	evidence: new Set(["--request-file"]),
	"approve-ship": new Set(["--request-file"]),
	ship: new Set(["--request-file"]),
	"reconcile-ship": new Set(),
	status: new Set(),
	"mailbox-status": new Set([
		"--session",
		"--agent",
		"--delivery-credential-file",
	]),
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

interface DeliveryCredential {
	credentialId: string;
	token: string;
}

function parseDeliveryCredential(
	value: unknown,
	source: string,
): DeliveryCredential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${source} is not a delivery credential`);
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.credentialId !== "string" ||
		record.credentialId.length === 0 ||
		typeof record.token !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.token)
	) {
		throw new TypeError(`${source} is not a delivery credential`);
	}
	return { credentialId: record.credentialId, token: record.token };
}

/**
 * Codex R3 HIGH-2: keep the pull credential out of argv and out of stdout.
 *
 * argv is world-readable to every same-uid process, which is exactly the
 * attacker in this finding, so the credential is never passed as a flag value --
 * only as a path to a 0600 file. Redacting it from the printed result keeps it
 * out of whatever collects the launcher's output.
 */
function stashDeliveryCredential(path: string, result: unknown): unknown {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new TypeError("register_lead result is not an object");
	}
	const record = result as Record<string, unknown>;
	const credential = parseDeliveryCredential(
		record.deliveryCredential,
		"register_lead result",
	);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// R3-F4 (FLY-1547): ATOMIC publish — private temp + fsync + rename + dir
	// fsync. The prior open(path,"w") truncated in place, so a crash mid-write
	// could leave an empty/partial credential AFTER the host had already
	// revoked the previous generation.
	const tempPath = `${path}.tmp-${process.pid}`;
	const fd = openSync(tempPath, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(credential)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tempPath, path);
	const dirFd = openSync(dirname(path), "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
	return { ...record, deliveryCredential: { storedAt: path } };
}

function readDeliveryCredential(path: string): DeliveryCredential {
	if ((statSync(path).mode & 0o777) !== 0o600) {
		throw new Error("delivery credential file must be mode 0600");
	}
	return parseDeliveryCredential(
		parseJsonFile(path, "--delivery-credential-file"),
		"--delivery-credential-file",
	);
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
			case "admit": {
				// FLY-1547 R3-F8: the founder outcome is "real issues spawn with
				// their title". The lead authors the request file by hand, so the
				// boundary nags loudly (without gating legacy fixtures).
				const draft = request as { issueTitle?: unknown; issueId?: unknown };
				if (
					typeof draft.issueTitle !== "string" ||
					draft.issueTitle.trim().length === 0
				) {
					process.stderr.write(
						`[flywheel-v2 admit] WARNING: issue ${String(draft.issueId)} is being admitted WITHOUT issueTitle — runners will not know what the issue is called. Add "issueTitle" to the admit request.\n`,
					);
				}
				return await admitIssueDag(
					kernel,
					ports,
					request as Parameters<typeof admitIssueDag>[2],
				);
			}
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
			const credentialOut = parsed.values.get("--delivery-credential-out");
			if (credentialOut !== undefined && !isAbsolute(credentialOut)) {
				throw new TypeError("--delivery-credential-out must be absolute");
			}
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
			if (credentialOut !== undefined) {
				result = stashDeliveryCredential(credentialOut, result);
			}
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
		case "ask":
			result = await client.request("ask", {
				sessionRef: requireValue(parsed.values, "--session"),
				askKind: requireValue(parsed.values, "--ask-kind"),
				payload: requireValue(parsed.values, "--payload"),
				...(parsed.values.has("--uid")
					? { uid: requireValue(parsed.values, "--uid") }
					: {}),
			});
			break;
		case "next":
			if (parsed.values.has("--session")) {
				if (
					parsed.values.has("--agent") ||
					parsed.values.has("--delivery-credential-file")
				) {
					throw new TypeError(
						"--session cannot be combined with --agent or --delivery-credential-file",
					);
				}
				result = await client.request("next_delivery", {
					sessionRef: requireValue(parsed.values, "--session"),
				});
				break;
			}
			result = await client.request("next_delivery", {
				agentId: requireValue(parsed.values, "--agent"),
				deliveryCredential: readDeliveryCredential(
					requireAbsolute(parsed.values, "--delivery-credential-file"),
				),
			});
			break;
		case "mailbox-status":
			// FLY-1547: same identity forms as `next` — a runner names its session,
			// a lead presents its delivery credential file.
			if (parsed.values.has("--session")) {
				if (
					parsed.values.has("--agent") ||
					parsed.values.has("--delivery-credential-file")
				) {
					throw new TypeError(
						"--session cannot be combined with --agent or --delivery-credential-file",
					);
				}
				result = await client.mailboxStatus({
					sessionRef: requireValue(parsed.values, "--session"),
				});
				break;
			}
			result = await client.mailboxStatus({
				...(parsed.values.has("--agent")
					? { agentId: requireValue(parsed.values, "--agent") }
					: {}),
				deliveryCredential: readDeliveryCredential(
					requireAbsolute(parsed.values, "--delivery-credential-file"),
				),
			});
			break;
		case "ack":
			result = await client.submitProposalWithRetry({
				agentId: requireValue(parsed.values, "--agent"),
				attemptUid: requireValue(parsed.values, "--attempt"),
				messageUid: requireValue(parsed.values, "--message"),
				effects: [],
				authorization: {
					capabilityId: requireValue(parsed.values, "--capability-id"),
					token: requireValue(parsed.values, "--token"),
				},
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
