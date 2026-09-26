import { randomUUID } from "node:crypto";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { normalizeOptionalBearer } from "flywheel-config";
import { currentWorkflowActivationFromEnv } from "./workflow-activation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9._-]{1,40}$/;
const SUCCEEDED = new Set(["ready", "torn_down"]);
const FAILED = new Set([
	"failed",
	"refused",
	"released",
	"interrupted",
	"teardown_failed",
]);
const RUNNING = new Set(["queued", "preparing", "deploying", "tearing_down"]);
const BOOLEAN_FLAGS = [
	"generalized",
	"test-discipline",
	"codex-runner",
	"stub-runner",
	"no-lead",
	"alerts",
	"alert-duty",
	"codex-home-reconcile",
] as const;
const ENV_VALUES: Record<string, readonly string[]> = {
	TEST_REPLY_BY_ISSUE: ["0", "1"],
	TEST_BRIDGE_DEPT_SCOPE_REJECT: ["on", "off"],
	TEST_CODEX_LEAD_OUTBOUND_MODE: ["direct", "bridge"],
};
const HELP = `Usage: flywheel-comm room deploy|teardown|status|wait|list [options]
  deploy --head <lowercase-sha40> [--expect-head <same source SHA>]
    [--slot auto|<positive-int>] [--mode slot|mirror|roundtable] [--from-branch main]
    [--generalized] [--test-discipline] [--codex-runner] [--stub-runner] [--no-lead]
    [--alerts] [--alert-duty] [--codex-home-reconcile] [--extra-lead <slot:label>] (max 4)
    [--lead-label <label>] [--lead-ready-timeout <1..3600>] [--lead-channel-timeout <1..3600>]
    (timeout flags also accept a -sec suffix) [--digest <17..20 digits>]
    [--env TEST_REPLY_BY_ISSUE=0|1] [--env TEST_BRIDGE_DEPT_SCOPE_REJECT=on|off]
    [--env TEST_CODEX_LEAD_OUTBOUND_MODE=direct|bridge]
  teardown --room <uuid> [--skip-snapshot --reason <1..200 characters>]
  status|wait --room <uuid>
  deploy|teardown: [--request-id <uuid>] [--wait|--no-wait] (default: wait)
  deploy|teardown|wait: [--timeout-sec <1..1800>] (default: 1800)
  Authentication: [--exec-id <uuid>] or FLYWHEEL_EXEC_ID with FLYWHEEL_INGEST_TOKEN
    and the current workflow submission credential when available. Lead: [--lead], TEAMLEAD_API_TOKEN,
    FLYWHEEL_LEAD_ID. Runner identity takes precedence unless --lead is explicit.
  Bridge: FLYWHEEL_BRIDGE_URL (default: http://127.0.0.1:9876).
  Output: JSON lines; waiting prints the initial room handle and changed snapshots.
  Exit: 0 ready/torn_down/list, 1 refused/failed/request error, 2 transport failure,
    3 still running (resume with room wait --room <room_id>).`;

export interface RoomCommandOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	credentialResolver?: (
		executionId: string,
		env: NodeJS.ProcessEnv,
	) => string | undefined;
	randomId?: () => string;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	attemptTimeoutMs?: number;
}

class RoomCommandError extends Error {
	constructor(
		message: string,
		readonly exitCode = 1,
	) {
		super(message);
	}
}

type Values = Record<string, string | boolean | string[] | undefined>;
interface Command {
	action: string;
	values: Values;
	roomId?: string;
	requestId?: string;
	body?: Record<string, unknown>;
	wait: boolean;
	timeoutMs: number;
}
interface RoomResponse extends Record<string, unknown> {
	room_id: string;
	status: string;
}

function requireValid(condition: unknown, message: string): asserts condition {
	if (!condition) throw new RoomCommandError(message);
}

function integer(
	value: unknown,
	flag: string,
	max = Number.MAX_SAFE_INTEGER,
): number {
	requireValid(
		typeof value === "string" && /^[1-9][0-9]*$/.test(value),
		`${flag} must be a positive integer`,
	);
	const result = Number(value);
	requireValid(
		Number.isSafeInteger(result) && result <= max,
		`${flag} is out of range`,
	);
	return result;
}

function alias(
	values: Values,
	canonical: string,
	alternative: string,
): string | undefined {
	requireValid(
		values[canonical] === undefined ||
			values[alternative] === undefined ||
			values[canonical] === values[alternative],
		`--${canonical} and --${alternative} disagree`,
	);
	return (values[canonical] ?? values[alternative]) as string | undefined;
}

function deployBody(values: Values): Record<string, unknown> {
	const head = alias(values, "head", "expect-head");
	requireValid(
		head && /^[a-f0-9]{40}$/.test(head),
		"--head must be lowercase 40-hex",
	);
	const slot =
		values.slot === undefined || values.slot === "auto"
			? "auto"
			: integer(values.slot, "--slot");
	const mode = values.mode ?? "slot";
	requireValid(
		["slot", "mirror", "roundtable"].includes(String(mode)),
		"--mode is invalid",
	);
	const branch = (values["from-branch"] ?? "main") as string;
	requireValid(
		/^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
			!branch.includes(".."),
		"--from-branch is invalid",
	);
	const extras = (values["extra-lead"] ?? []) as string[];
	requireValid(extras.length <= 4, "--extra-lead allows at most four entries");
	const extraLeads = extras.map((entry) => {
		const parts = entry.split(":");
		requireValid(
			parts.length === 2 && LABEL.test(parts[1]!),
			"--extra-lead must be slot:label",
		);
		return { slot: integer(parts[0], "--extra-lead slot"), label: parts[1]! };
	});
	requireValid(
		new Set(extraLeads.map((lead) => lead.slot)).size === extraLeads.length &&
			!extraLeads.some((lead) => lead.slot === slot),
		"--extra-lead slots must be distinct",
	);
	const env: Record<string, string> = {};
	for (const entry of (values.env ?? []) as string[]) {
		const separator = entry.indexOf("=");
		const key = entry.slice(0, separator);
		const value = entry.slice(separator + 1);
		requireValid(
			separator > 0 &&
				Object.hasOwn(ENV_VALUES, key) &&
				ENV_VALUES[key]!.includes(value) &&
				!Object.hasOwn(env, key),
			"--env requires a unique supported KEY=value",
		);
		env[key] = value;
	}
	const body: Record<string, unknown> = {
		head,
		slot,
		mode,
		from_branch: branch,
		extra_leads: extraLeads,
		env,
	};
	for (const flag of BOOLEAN_FLAGS)
		body[flag.replaceAll("-", "_")] = values[flag] === true;
	if (values["lead-label"] !== undefined) {
		requireValid(
			LABEL.test(String(values["lead-label"])),
			"--lead-label is invalid",
		);
		body.lead_label = values["lead-label"];
	}
	for (const key of ["lead-ready-timeout", "lead-channel-timeout"]) {
		const value = alias(values, key, `${key}-sec`);
		if (value !== undefined)
			body[`${key.replaceAll("-", "_")}_sec`] = integer(
				value,
				`--${key}`,
				3600,
			);
	}
	if (values.digest !== undefined) {
		requireValid(
			/^\d{17,20}$/.test(String(values.digest)),
			"--digest must contain 17..20 digits",
		);
		body.digest_channel = values.digest;
	}
	return body;
}

function parseCommand(args: string[], randomId: () => string): Command {
	const [action, ...rest] = args;
	requireValid(
		action && ["deploy", "teardown", "status", "wait", "list"].includes(action),
		"expected deploy|teardown|status|wait|list",
	);
	const mutation = action === "deploy" || action === "teardown";
	const options: NonNullable<ParseArgsConfig["options"]> = {
		"exec-id": { type: "string" },
		lead: { type: "boolean" },
		help: { type: "boolean" },
		json: { type: "boolean" },
	};
	if (action !== "deploy" && action !== "list")
		options.room = { type: "string" };
	if (mutation || action === "wait")
		options["timeout-sec"] = { type: "string" };
	if (mutation) {
		options["request-id"] = { type: "string" };
		options.wait = { type: "boolean" };
		options["no-wait"] = { type: "boolean" };
	}
	if (action === "teardown") {
		options["skip-snapshot"] = { type: "boolean" };
		options.reason = { type: "string" };
	}
	if (action === "deploy") {
		for (const key of [
			"head",
			"expect-head",
			"slot",
			"mode",
			"from-branch",
			"lead-label",
			"lead-ready-timeout",
			"lead-ready-timeout-sec",
			"lead-channel-timeout",
			"lead-channel-timeout-sec",
			"digest",
		])
			options[key] = { type: "string" };
		for (const key of BOOLEAN_FLAGS) options[key] = { type: "boolean" };
		for (const key of ["extra-lead", "env"])
			options[key] = { type: "string", multiple: true };
	}
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: rest,
			options,
			allowPositionals: false,
			strict: true,
			tokens: true,
		});
	} catch {
		throw new RoomCommandError(
			"invalid or unsupported arguments; use room --help",
		);
	}
	const seen = new Set<string>();
	for (const token of parsed.tokens ?? []) {
		if (token.kind !== "option" || options[token.name]?.multiple) continue;
		requireValid(!seen.has(token.name), "duplicate option; use room --help");
		seen.add(token.name);
	}
	const values = parsed.values as Values;
	if (values.help) return { action, values, wait: false, timeoutMs: 0 };
	requireValid(
		!(values.wait && values["no-wait"]),
		"--wait and --no-wait are mutually exclusive",
	);
	requireValid(
		!(values.lead && values["exec-id"]),
		"--lead and --exec-id are mutually exclusive",
	);
	const timeoutMs =
		integer(values["timeout-sec"] ?? "1800", "--timeout-sec", 1800) * 1000;
	const roomId = values.room as string | undefined;
	if (action !== "deploy" && action !== "list")
		requireValid(roomId && UUID.test(roomId), "--room must be a UUID");
	let body: Record<string, unknown> | undefined;
	let requestId: string | undefined;
	if (mutation) {
		requestId = (values["request-id"] as string | undefined) ?? randomId();
		requireValid(UUID.test(requestId), "--request-id must be a UUID");
		if (action === "deploy") body = deployBody(values);
		else {
			const skip = values["skip-snapshot"] === true;
			const reason = (values.reason as string | undefined)?.trim();
			requireValid(
				skip === (reason !== undefined) &&
					(reason === undefined || (reason.length > 0 && reason.length <= 200)),
				"--skip-snapshot requires --reason of 1..200 characters; --reason requires --skip-snapshot",
			);
			body = {
				skip_snapshot: skip,
				...(reason === undefined ? {} : { reason }),
			};
		}
		body.request_id = requestId;
	}
	return {
		action,
		values,
		roomId,
		requestId,
		body,
		wait: action === "wait" || (mutation && !values["no-wait"]),
		timeoutMs,
	};
}

function isRoom(value: unknown, expectedId?: string): value is RoomResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const room = value as Record<string, unknown>;
	return (
		typeof room.room_id === "string" &&
		UUID.test(room.room_id) &&
		(!expectedId || room.room_id === expectedId) &&
		typeof room.status === "string" &&
		(SUCCEEDED.has(room.status) ||
			FAILED.has(room.status) ||
			RUNNING.has(room.status))
	);
}

function printableRoom(room: RoomResponse, secrets: string[]): unknown {
	const fields = [
		"room_id",
		"operation_id",
		"status",
		"status_reason",
		"roomInfo",
		"evidence_dir",
		"residue_check",
		"log_tail",
		"queue_reason",
		"load1",
		"threshold",
		"owner_terminal",
		"recovery_hint",
	];
	const result = Object.fromEntries(
		fields
			.filter((field) => Object.hasOwn(room, field))
			.map((field) => [field, room[field]]),
	);
	// Redact string values before JSON encoding so quotes/newlines in credentials
	// cannot bypass replacement through JSON escaping.
	function redact(value: unknown): unknown {
		if (typeof value === "string") {
			for (const secret of secrets)
				if (secret) value = (value as string).split(secret).join("[REDACTED]");
			return value;
		}
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(
						([key]) =>
							// QA consumes these file locations, never their token contents.
							key === "apiTokenPath" ||
							key === "tokenPath" ||
							!/token|credential|authorization|password|secret/i.test(key),
					)
					.map(([key, child]) => [key, redact(child)]),
			);
		return value;
	}
	return redact(result);
}

export async function runRoomCommand(
	args: string[],
	opts: RoomCommandOptions = {},
): Promise<number> {
	const stdout = opts.stdout ?? console.log;
	const stderr = opts.stderr ?? console.error;
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		stdout(HELP);
		return 0;
	}
	let command: Command | undefined;
	let lastRoom: RoomResponse | undefined;
	try {
		command = parseCommand(args, opts.randomId ?? randomUUID);
		if (command.values.help) {
			stdout(HELP);
			return 0;
		}
		const env = opts.env ?? process.env;
		const execId = (
			(command.values["exec-id"] as string | undefined) ??
			env.FLYWHEEL_EXEC_ID ??
			""
		).trim();
		const lead = command.values.lead === true || !execId;
		const token = normalizeOptionalBearer(
			(lead ? env.TEAMLEAD_API_TOKEN : env.FLYWHEEL_INGEST_TOKEN)
				?.trim()
				.replace(/^Bearer\s+/i, ""),
		);
		requireValid(
			token,
			lead
				? "TEAMLEAD_API_TOKEN is required"
				: "FLYWHEEL_INGEST_TOKEN is required",
		);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
		};
		let credential: string | undefined;
		if (lead) {
			const leadId = env.FLYWHEEL_LEAD_ID?.trim();
			requireValid(
				leadId && !/[\r\n]/.test(leadId),
				"FLYWHEEL_LEAD_ID is required",
			);
			headers["X-Flywheel-Lead-Id"] = leadId;
		} else {
			requireValid(
				UUID.test(execId),
				"--exec-id or FLYWHEEL_EXEC_ID must be a UUID",
			);
			try {
				if (opts.credentialResolver)
					credential = opts.credentialResolver(execId, env);
				else {
					const activation = currentWorkflowActivationFromEnv(execId, env);
					credential = activation
						? (activation.submission_credential ?? undefined)
						: env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL?.trim() || undefined;
				}
			} catch {
				throw new RoomCommandError(
					"current workflow submission credential is unavailable",
				);
			}
			if (command.body)
				Object.assign(command.body, {
					execution_id: execId,
					...(credential ? { credential } : {}),
				});
		}
		const bridge = (
			env.FLYWHEEL_BRIDGE_URL?.trim() || "http://127.0.0.1:9876"
		).replace(/\/+$/, "");
		try {
			const url = new URL(bridge);
			requireValid(
				["http:", "https:"].includes(url.protocol) &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash,
				"FLYWHEEL_BRIDGE_URL is invalid",
			);
		} catch {
			throw new RoomCommandError("FLYWHEEL_BRIDGE_URL is invalid");
		}
		const secrets = [
			token,
			credential,
			env.FLYWHEEL_INGEST_TOKEN,
			env.TEAMLEAD_API_TOKEN,
			env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL,
		].filter((value): value is string => Boolean(value));
		const fetchImpl = opts.fetchImpl ?? fetch;
		const sleep =
			opts.sleepImpl ??
			((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const now = opts.now ?? Date.now;
		const deadline = now() + command.timeoutMs;
		const request = async (
			path: string,
			body?: Record<string, unknown>,
			until?: number,
		): Promise<unknown> => {
			const requestHeaders = { ...headers };
			if (body) requestHeaders["Content-Type"] = "application/json";
			else if (!lead) {
				requestHeaders["X-Flywheel-Execution-Id"] = execId;
				if (credential)
					requestHeaders["X-Flywheel-Submission-Credential"] = credential;
			}
			const serialized = body ? JSON.stringify(body) : undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (until !== undefined && now() >= until)
					throw new RoomCommandError("wait deadline reached", 3);
				const controller = new AbortController();
				const timeout = Math.min(
					opts.attemptTimeoutMs ?? 15_000,
					until === undefined ? Infinity : until - now(),
				);
				const timer = setTimeout(() => controller.abort(), timeout);
				try {
					const response = await fetchImpl(`${bridge}${path}`, {
						method: body ? "POST" : "GET",
						headers: requestHeaders,
						body: serialized,
						signal: controller.signal,
						redirect: "error",
					});
					if (response.ok) {
						try {
							return await response.json();
						} catch (error) {
							if (error instanceof SyntaxError)
								throw new RoomCommandError("invalid JSON response");
							throw error;
						}
					}
					if (
						response.status !== 408 &&
						response.status !== 429 &&
						response.status < 500
					)
						throw new RoomCommandError(
							`request refused (HTTP ${response.status})`,
						);
					await response.body?.cancel();
				} catch (error) {
					if (error instanceof RoomCommandError) throw error;
					// Raw errors and response bodies may contain bearer credentials.
				} finally {
					clearTimeout(timer);
				}
				if (attempt < 2) {
					const delay = (attempt + 1) * 1000;
					await sleep(
						until === undefined
							? delay
							: Math.max(0, Math.min(delay, until - now())),
					);
				}
			}
			if (until !== undefined && now() >= until)
				throw new RoomCommandError("wait deadline reached", 3);
			throw new RoomCommandError("transport failure after 3 attempts", 2);
		};
		const path = `/api/qa-rooms${command.roomId ? `/${command.roomId}` : ""}${command.action === "teardown" ? "/teardown" : ""}`;
		let body = await request(path, command.body);
		if (command.action === "list") {
			const list = body as { ok?: unknown; rooms?: unknown } | null;
			requireValid(
				list?.ok === true &&
					Array.isArray(list.rooms) &&
					list.rooms.every((room) => isRoom(room)),
				"invalid room list response",
			);
			stdout(
				JSON.stringify({
					ok: true,
					rooms: (list.rooms as RoomResponse[]).map((room) =>
						printableRoom(room, secrets),
					),
				}),
			);
			return 0;
		}
		let previousOutput: string | undefined;
		for (;;) {
			requireValid(
				isRoom(body, command.roomId ?? lastRoom?.room_id) && body.ok === true,
				"invalid room response",
			);
			lastRoom = body;
			const output = JSON.stringify({
				ok: true,
				...(printableRoom(lastRoom, secrets) as object),
			});
			if (output !== previousOutput) stdout(output);
			previousOutput = output;
			if (SUCCEEDED.has(lastRoom.status)) return 0;
			if (FAILED.has(lastRoom.status)) return 1;
			if (!command.wait || now() >= deadline) return 3;
			await sleep(Math.min(2000, deadline - now()));
			if (now() >= deadline) return 3;
			body = await request(
				`/api/qa-rooms/${lastRoom.room_id}`,
				undefined,
				deadline,
			);
		}
	} catch (error) {
		const failure =
			error instanceof RoomCommandError
				? error
				: new RoomCommandError("command failed");
		stderr(
			`room: ${failure.message}${command?.requestId ? `; request_id=${command.requestId}` : ""}${lastRoom?.room_id || command?.roomId ? `; room_id=${lastRoom?.room_id ?? command?.roomId}` : ""}`,
		);
		return failure.exitCode;
	}
}
