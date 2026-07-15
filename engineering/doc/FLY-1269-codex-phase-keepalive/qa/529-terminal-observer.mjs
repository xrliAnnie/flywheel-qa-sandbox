#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const HEARTBEAT_FRESH_MS = 120_000;
const DEFAULT_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_ARMING_ATTEMPTS = 5;
const DEFAULT_ARMING_TIMEOUT_MS = 10_000;
const SOCKET_PROBE_TIMEOUT_MS = 250;
const REQUIRED = [
	"state-db",
	"comm-db",
	"issue",
	"design-exec",
	"implement-exec",
	"qa-exec",
	"socket-root",
	"out",
];

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--once") {
			options.once = true;
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
		const name = arg.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`missing value for --${name}`);
		options[name] = value;
		index += 1;
	}
	for (const name of REQUIRED) {
		if (!options[name]) throw new Error(`missing required --${name}`);
	}
	for (const name of ["state-db", "comm-db", "socket-root", "out"]) {
		if (!path.isAbsolute(options[name]))
			throw new Error(`--${name} must be absolute`);
	}
	for (const name of ["issue", "design-exec", "implement-exec", "qa-exec"]) {
		if (!/^[A-Za-z0-9._:-]+$/.test(options[name])) {
			throw new Error(`invalid --${name}`);
		}
	}
	options.intervalMs = parsePositiveInt(
		options["interval-ms"] ?? DEFAULT_INTERVAL_MS,
		"interval-ms",
	);
	options.timeoutMs = parsePositiveInt(
		options["timeout-ms"] ?? DEFAULT_TIMEOUT_MS,
		"timeout-ms",
	);
	options.armingAttempts = parsePositiveInt(
		options["arming-attempts"] ?? DEFAULT_ARMING_ATTEMPTS,
		"arming-attempts",
	);
	options.armingTimeoutMs = parsePositiveInt(
		options["arming-timeout-ms"] ?? DEFAULT_ARMING_TIMEOUT_MS,
		"arming-timeout-ms",
	);
	return options;
}

function parsePositiveInt(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0)
		throw new Error(`--${name} must be a positive integer`);
	return parsed;
}

function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function queryReadonly(dbPath, sql) {
	let lastError;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			const output = execFileSync(
				"sqlite3",
				["-readonly", "-json", dbPath, `PRAGMA query_only=1;${sql}`],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim();
			return output ? JSON.parse(output) : [];
		} catch (error) {
			lastError = error;
			const detail = `${error?.stderr ?? ""}${error?.message ?? ""}`;
			if (!/database is locked|database is busy/i.test(detail)) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	throw lastError;
}

function indexBy(rows, field) {
	return Object.fromEntries(rows.map((row) => [row[field], row]));
}

function heartbeatMs(value) {
	if (!value) return null;
	const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value)
		? value
		: `${value.replace(" ", "T")}Z`;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function probeTmux(target, seenLive) {
	if (!target) return "indeterminate";
	const result = spawnSync(
		"tmux",
		["display-message", "-p", "-t", target, "#{pane_dead}"],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.error) return "indeterminate";
	if (result.status === 0) {
		const paneDead = result.stdout.trim();
		if (paneDead === "0") return "live";
		if (paneDead === "1") return "dead";
		return "indeterminate";
	}
	if (
		result.status === 1 &&
		/^can't find (?:pane|window|session):/m.test(result.stderr.trim())
	) {
		return "absent";
	}
	if (
		seenLive &&
		result.status === 1 &&
		/^no server running on /m.test(result.stderr.trim())
	) {
		return "absent";
	}
	return "indeterminate";
}

function socketAliases(socket) {
	const aliases = new Set([socket]);
	try {
		aliases.add(
			path.join(realpathSync(path.dirname(socket)), path.basename(socket)),
		);
	} catch {
		// Keep the raw path. The startup liveness gate will fail closed if the
		// socket root itself cannot be resolved or observed.
	}
	return [...aliases];
}

function benignLsofStderr(stderr) {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (let index = 0; index < lines.length; index += 1) {
		if (
			!/^lsof: WARNING: can't stat\(\) .+ file system .+$/.test(lines[index])
		) {
			return false;
		}
		if (lines[index + 1] !== "Output information may be incomplete.") {
			return false;
		}
		index += 1;
	}
	return true;
}

function probeHolders(aliasesBySocket) {
	const uniqueSockets = Object.keys(aliasesBySocket);
	const observedAt = new Date().toISOString();
	const indeterminate = () =>
		Object.fromEntries(
			uniqueSockets.map((socket) => [
				socket,
				{ state: "indeterminate", holders: [], observedAt },
			]),
		);
	const result = spawnSync("lsof", ["-nU", "-Fpn"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0 || !benignLsofStderr(result.stderr)) {
		return indeterminate();
	}

	let currentPid = null;
	let sawPid = false;
	let sawName = false;
	let malformed = false;
	const holdersBySocket = new Map(
		uniqueSockets.map((socket) => [socket, new Set()]),
	);
	const socketsByAlias = new Map();
	for (const [socket, aliases] of Object.entries(aliasesBySocket)) {
		for (const alias of aliases) {
			const matches = socketsByAlias.get(alias) ?? [];
			matches.push(socket);
			socketsByAlias.set(alias, matches);
		}
	}
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		if (line.startsWith("p")) {
			const pid = Number(line.slice(1));
			if (!Number.isInteger(pid) || pid <= 0) {
				malformed = true;
				currentPid = null;
			} else {
				currentPid = pid;
				sawPid = true;
			}
			continue;
		}
		if (line.startsWith("f")) continue;
		if (line.startsWith("n")) {
			sawName = true;
			if (currentPid === null) {
				malformed = true;
			} else {
				for (const socket of socketsByAlias.get(line.slice(1)) ?? []) {
					holdersBySocket.get(socket)?.add(currentPid);
				}
			}
			continue;
		}
		malformed = true;
	}
	if (malformed || !sawPid || !sawName) {
		return indeterminate();
	}
	return Object.fromEntries(
		[...holdersBySocket].map(([socket, holders]) => {
			const holderList = [...holders].sort((left, right) => left - right);
			return [
				socket,
				holderList.length > 0
					? { state: "present", holders: holderList, observedAt }
					: { state: "absent", holders: [], observedAt },
			];
		}),
	);
}

function probeSocket(socket) {
	return new Promise((resolve) => {
		let settled = false;
		const client = net.createConnection(socket);
		const finish = (state) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.destroy();
			resolve(state);
		};
		const timer = setTimeout(
			() => finish("indeterminate"),
			SOCKET_PROBE_TIMEOUT_MS,
		);
		client.once("connect", () => finish("live"));
		client.once("error", (error) => {
			if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error?.code)) {
				finish("absent");
			} else {
				finish("indeterminate");
			}
		});
	});
}

function socketFor(root, executionId) {
	const hash = createHash("sha1")
		.update(executionId)
		.digest("hex")
		.slice(0, 16);
	return path.join(root, `${hash}.sock`);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function changedKey(frame) {
	const copy = structuredClone(frame);
	delete copy.at;
	for (const liveness of Object.values(copy.liveness ?? {})) {
		delete liveness.heartbeatAgeMs;
	}
	return JSON.stringify(copy);
}

function appendFrame(out, frame) {
	appendFileSync(out, `${JSON.stringify(frame)}\n`);
}

function last(array) {
	return array[array.length - 1];
}

function recordShutdown(history, row, at) {
	if (!row) return;
	const previous = last(history);
	if (previous?.requestId === row.request_id && previous?.state === row.state)
		return;
	if (previous && previous.requestId !== row.request_id) {
		throw new Error(
			`shutdown_request_id_changed:${previous.requestId}:${row.request_id}`,
		);
	}
	if (row.state === "acked" && previous && previous.state !== "requested") {
		throw new Error(`shutdown_ack_out_of_order:${row.execution_id}`);
	}
	history.push({
		state: row.state,
		requestId: row.request_id,
		observedAt: at,
		requestedAt: row.requested_at,
		finishedAt: row.finished_at ?? null,
		error: row.error ?? null,
	});
}

function matchingCloseEvent(events, executionId, requestId) {
	return events.some((event) => {
		if (
			event.execution_id !== executionId ||
			event.event_type !== "lead_close_runner"
		)
			return false;
		try {
			const payload =
				typeof event.payload === "string"
					? JSON.parse(event.payload)
					: event.payload;
			return payload?.phaseShutdownRequestId === requestId;
		} catch {
			return false;
		}
	});
}

function classifyExecution({ executionId, history, events, lastPresent }) {
	const requested = history.find((item) => item.state === "requested");
	const acked = history.find((item) => item.state === "acked");
	const failed = history.find((item) => item.state === "failed");
	if (failed) {
		return {
			classification: "failed",
			rerunRequired: false,
			reason: `shutdown_failed:${executionId}`,
		};
	}
	if (requested && acked && requested.requestId === acked.requestId) {
		return { classification: "graceful", rerunRequired: false };
	}
	if (requested) {
		if (matchingCloseEvent(events, executionId, requested.requestId)) {
			return { classification: "graceful_corroborated", rerunRequired: false };
		}
		return {
			classification: "unproven",
			rerunRequired: false,
			reason: `missing_shutdown_ack_corroboration:${executionId}`,
		};
	}
	if (acked) {
		if (matchingCloseEvent(events, executionId, acked.requestId)) {
			return { classification: "graceful_corroborated", rerunRequired: false };
		}
		return {
			classification: "unproven",
			rerunRequired: false,
			reason: `missing_shutdown_request_corroboration:${executionId}`,
		};
	}
	if (!lastPresent) {
		return {
			classification: "indeterminate",
			rerunRequired: false,
			reason: `liveness_indeterminate:${executionId}:no_present_frame`,
		};
	}
	if (
		lastPresent.tmux === "indeterminate" ||
		lastPresent.socket === "indeterminate" ||
		lastPresent.holders.state === "indeterminate" ||
		lastPresent.heartbeatFresh === null
	) {
		return {
			classification: "indeterminate",
			rerunRequired: false,
			reason: `liveness_indeterminate:${executionId}`,
		};
	}
	if (
		lastPresent.heartbeatFresh === false ||
		(lastPresent.tmux === "absent" &&
			lastPresent.socket === "absent" &&
			lastPresent.holders.state === "absent")
	) {
		return { classification: "direct_proven", rerunRequired: true };
	}
	return {
		classification: "unproven",
		rerunRequired: false,
		reason: `missing_shutdown_request:${executionId}`,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	mkdirSync(path.dirname(options.out), { recursive: true });
	const identities = {
		design: options["design-exec"],
		implement: options["implement-exec"],
		qa: options["qa-exec"],
	};
	const codexRoles = ["design", "implement"];
	const executionIds = Object.values(identities);
	const idList = executionIds.map(sqlLiteral).join(",");
	const codexIdList = codexRoles
		.map((role) => sqlLiteral(identities[role]))
		.join(",");
	const histories = { design: [], implement: [] };
	const socketsByRole = Object.fromEntries(
		codexRoles.map((role) => [
			role,
			socketFor(options["socket-root"], identities[role]),
		]),
	);
	const aliasesBySocket = Object.fromEntries(
		Object.values(socketsByRole).map((socket) => [
			socket,
			socketAliases(socket),
		]),
	);
	const savedTargets = {};
	const tmuxSeenLive = {};
	const lastPresent = {};
	let holdersBySocket = null;
	let lastHolderEvidenceKey = null;
	let armed = false;
	let lastKey = null;
	let pendingReason = "cleanup_not_observed";
	const startedAt = Date.now();
	const armingDeadlineAt =
		startedAt + Math.min(options.armingTimeoutMs, options.timeoutMs);
	let armingAttempts = 0;

	while (true) {
		const at = new Date().toISOString();
		let stateRows;
		let eventRows;
		let commRows;
		let shutdownRows;
		let turnRows;
		try {
			stateRows = queryReadonly(
				options["state-db"],
				`SELECT execution_id,issue_id,status,heartbeat_at,tmux_session,adapter_type,chat_thread_role,runner_model FROM sessions WHERE execution_id IN (${idList});`,
			);
			eventRows = queryReadonly(
				options["state-db"],
				`SELECT execution_id,event_type,payload,ts FROM session_events WHERE execution_id IN (${codexIdList}) AND event_type='lead_close_runner' ORDER BY id;`,
			);
			commRows = queryReadonly(
				options["comm-db"],
				`SELECT execution_id,tmux_window,status FROM sessions WHERE execution_id IN (${idList});`,
			);
			shutdownRows = queryReadonly(
				options["comm-db"],
				`SELECT execution_id,request_id,state,requested_at,finished_at,error FROM runner_shutdown_controls WHERE execution_id IN (${codexIdList});`,
			);
			turnRows = queryReadonly(
				options["comm-db"],
				`SELECT issue_id,holder_exec_id,phase,epoch,granted_at FROM three_stage_turn WHERE issue_id=${sqlLiteral(options.issue)};`,
			);
		} catch (error) {
			const frame = {
				kind: "verdict",
				at,
				pass: false,
				reason: `readonly_query_failed:${error.message}`,
			};
			appendFrame(options.out, frame);
			return 1;
		}

		const state = indexBy(stateRows, "execution_id");
		const comm = indexBy(commRows, "execution_id");
		const shutdownById = indexBy(shutdownRows, "execution_id");
		const stateGone = executionIds.every((executionId) => !state[executionId]);
		const commGone = executionIds.every((executionId) => !comm[executionId]);
		const codexStateGone = codexRoles.every((role) => !state[identities[role]]);
		const codexCommGone = codexRoles.every((role) => !comm[identities[role]]);
		const liveness = {};
		for (const role of Object.keys(identities)) {
			const executionId = identities[role];
			const stateRow = state[executionId];
			const commRow = comm[executionId];
			const target =
				stateRow?.tmux_session ??
				commRow?.tmux_window ??
				savedTargets[role] ??
				null;
			if (target) savedTargets[role] = target;
			const heartbeat = heartbeatMs(stateRow?.heartbeat_at);
			const socket = socketsByRole[role] ?? null;
			const tmux = probeTmux(target, tmuxSeenLive[role] === true);
			if (tmux === "live") tmuxSeenLive[role] = true;
			const current = {
				target,
				tmux,
				heartbeatAt: stateRow?.heartbeat_at ?? null,
				heartbeatAgeMs:
					heartbeat === null ? null : Math.max(0, Date.now() - heartbeat),
				heartbeatFresh:
					heartbeat === null
						? null
						: Date.now() - heartbeat <= HEARTBEAT_FRESH_MS,
				...(socket
					? {
							socketPath: socket,
							socket: await probeSocket(socket),
						}
					: {}),
			};
			liveness[role] = current;
		}

		const holderEvidenceKey = JSON.stringify(
			codexRoles.map((role) => ({
				role,
				socket: liveness[role].socket,
				statePresent: Boolean(state[identities[role]]),
				commPresent: Boolean(comm[identities[role]]),
			})),
		);
		if (
			holdersBySocket === null ||
			holderEvidenceKey !== lastHolderEvidenceKey
		) {
			holdersBySocket = probeHolders(aliasesBySocket);
			lastHolderEvidenceKey = holderEvidenceKey;
		}
		for (const role of codexRoles) {
			liveness[role].holders = holdersBySocket[socketsByRole[role]];
		}
		for (const role of Object.keys(identities)) {
			const executionId = identities[role];
			if (state[executionId] || comm[executionId]) {
				lastPresent[role] = structuredClone(liveness[role]);
			}
		}

		try {
			for (const role of codexRoles) {
				recordShutdown(histories[role], shutdownById[identities[role]], at);
			}
		} catch (error) {
			const frame = { kind: "verdict", at, pass: false, reason: error.message };
			appendFrame(options.out, frame);
			return 1;
		}

		const frame = {
			kind: "snapshot",
			at,
			issue: options.issue,
			identities,
			state,
			comm,
			turn: turnRows[0] ?? null,
			shutdown: Object.fromEntries(
				codexRoles.map((role) => [
					role,
					shutdownById[identities[role]] ?? null,
				]),
			),
			events: eventRows,
			liveness,
		};
		const key = changedKey(frame);
		if (key !== lastKey) {
			appendFrame(options.out, frame);
			lastKey = key;
		}
		if (options.once) return 0;
		if (!armed) {
			armingAttempts += 1;
			let initialFailure = null;
			for (const role of Object.keys(identities)) {
				if (liveness[role].tmux !== "live") {
					initialFailure = `initial_tmux_not_live:${role}:${liveness[role].tmux}`;
					break;
				}
				if (codexRoles.includes(role) && liveness[role].socket !== "live") {
					initialFailure = `initial_socket_not_live:${role}:${liveness[role].socket}`;
					break;
				}
				if (
					codexRoles.includes(role) &&
					liveness[role].holders.state !== "present"
				) {
					initialFailure = `initial_holders_not_present:${role}:${liveness[role].holders.state}`;
					break;
				}
			}
			if (
				initialFailure &&
				(armingAttempts >= options.armingAttempts ||
					Date.now() >= armingDeadlineAt)
			) {
				appendFrame(options.out, {
					kind: "verdict",
					at,
					pass: false,
					reason: initialFailure,
					arming: {
						attempts: armingAttempts,
						maxAttempts: options.armingAttempts,
						timeoutMs: options.armingTimeoutMs,
						deadlineAt: new Date(armingDeadlineAt).toISOString(),
					},
				});
				return 1;
			}
			if (initialFailure) {
				await sleep(options.intervalMs);
				continue;
			}
			armed = true;
		}

		if (stateGone && commGone) {
			if (turnRows.length > 0) {
				pendingReason = "turn_not_deleted";
			} else if (liveness.qa.tmux !== "absent") {
				pendingReason =
					liveness.qa.tmux === "indeterminate"
						? "qa_tmux_liveness_indeterminate"
						: "qa_tmux_not_deleted";
			} else {
				let cleanupFailure = null;
				for (const role of codexRoles) {
					if (liveness[role].tmux === "indeterminate") {
						cleanupFailure = `liveness_indeterminate:${identities[role]}:tmux`;
						break;
					}
					if (liveness[role].tmux !== "absent") {
						cleanupFailure = `tmux_not_deleted:${identities[role]}`;
						break;
					}
					if (liveness[role].socket === "indeterminate") {
						cleanupFailure = `liveness_indeterminate:${identities[role]}:socket`;
						break;
					}
					if (liveness[role].socket === "live") {
						cleanupFailure = `orphan_socket:${identities[role]}`;
						break;
					}
					if (liveness[role].holders.state === "indeterminate") {
						cleanupFailure = `liveness_indeterminate:${identities[role]}:lsof`;
						break;
					}
					if (liveness[role].holders.state === "present") {
						cleanupFailure = `orphan_holder:${identities[role]}`;
						break;
					}
				}
				if (cleanupFailure) {
					const verdict = {
						kind: "verdict",
						at,
						pass: false,
						reason: cleanupFailure,
					};
					appendFrame(options.out, verdict);
					return 1;
				}

				const classifications = {};
				for (const role of codexRoles) {
					classifications[role] = {
						...classifyExecution({
							executionId: identities[role],
							history: histories[role],
							events: eventRows,
							lastPresent: lastPresent[role],
						}),
						history: histories[role],
					};
				}
				const classificationFailure = codexRoles
					.map((role) => classifications[role].reason)
					.find(Boolean);
				const rerunRequired = codexRoles.some(
					(role) => classifications[role].rerunRequired,
				);
				const pass = !classificationFailure && !rerunRequired;
				const verdict = {
					kind: "verdict",
					at,
					pass,
					rerunRequired,
					reason:
						classificationFailure ??
						(rerunRequired ? "rerun_required_direct_proven" : null),
					executions: classifications,
				};
				appendFrame(options.out, verdict);
				return pass ? 0 : 1;
			}
		} else if (
			codexStateGone &&
			codexCommGone &&
			(state[identities.qa] || comm[identities.qa])
		) {
			pendingReason = "qa_session_not_deleted";
		}

		if (Date.now() - startedAt >= options.timeoutMs) {
			const verdict = {
				kind: "verdict",
				at: new Date().toISOString(),
				pass: false,
				reason: pendingReason,
				executions: Object.fromEntries(
					codexRoles.map((role) => [role, { history: histories[role] }]),
				),
			};
			appendFrame(options.out, verdict);
			return 1;
		}
		await sleep(options.intervalMs);
	}
}

try {
	process.exitCode = await main();
} catch (error) {
	process.stderr.write(`${error.stack ?? error.message}\n`);
	process.exitCode = 1;
}
