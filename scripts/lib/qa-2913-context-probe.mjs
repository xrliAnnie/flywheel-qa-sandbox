/** FLY-2913 diagnostic transport only. No user turn, model call or role baseline.
 * Caller owns room approval, deployment, final launcher settings and a fresh UUID.
 * This module neither creates a cwd nor changes HOME, auth, model or settings.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { summarizeClaudeContextDiagnostic } from "../qa-2913-prefix-inventory.mjs";

const MAX_STDOUT_BYTES = 1024 * 1024;
const usedSessions = new Set();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, code) => {
	if (!condition) throw new Error(code);
};
const slotPath = (path) =>
	/^\/(?:private\/)?tmp\/flywheel-test-slot-\d+\/.+/.test(path);
const identifier = (value, spaces = false) =>
	typeof value === "string" &&
	(spaces
		? /^[a-zA-Z0-9_][a-zA-Z0-9_.: -]{0,199}$/
		: /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,199}$/
	).test(value);

function validateLauncher(binary, args) {
	check(
		typeof binary === "string" && isAbsolute(binary) && !binary.includes("\0"),
		"invalid_launcher",
	);
	check(
		Array.isArray(args) &&
			args.every((v) => typeof v === "string" && !v.includes("\0")),
		"invalid_launcher",
	);
	check(args.join("").length <= MAX_STDOUT_BYTES, "invalid_launcher");
	const switches = new Set([
		"--print",
		"-p",
		"--verbose",
		"--no-chrome",
		"--strict-mcp-config",
		"--no-session-persistence",
	]);
	const values = new Set([
		"--session-id",
		"--model",
		"--effort",
		"--input-format",
		"--output-format",
		"--settings",
		"--permission-mode",
		"--append-system-prompt-file",
		"--tools",
		"--plugin-dir",
		"--mcp-config",
		"--setting-sources",
	]);
	const seen = new Map();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i] === "-p" ? "--print" : args[i];
		check(switches.has(flag) || values.has(flag), "invalid_launcher");
		check(!seen.has(flag) || flag === "--plugin-dir", "invalid_launcher");
		let value = true;
		if (values.has(flag)) {
			value = args[++i];
			check(
				typeof value === "string" && !value.startsWith("-"),
				"invalid_launcher",
			);
			check(
				value.length > 0 || flag === "--tools" || flag === "--setting-sources",
				"invalid_launcher",
			);
		}
		seen.set(flag, value);
	}
	check(
		seen.get("--verbose") === true &&
			seen.get("--input-format") === "stream-json" &&
			seen.get("--output-format") === "stream-json",
		"invalid_launcher",
	);
	check(
		typeof seen.get("--model") === "string" &&
			/^[a-zA-Z0-9_.-]+(?:\[[a-zA-Z0-9]+\])?$/.test(seen.get("--model")),
		"invalid_launcher",
	);
	check(
		["low", "medium", "high", "xhigh", "max"].includes(seen.get("--effort")),
		"invalid_launcher",
	);
	check(
		typeof seen.get("--session-id") === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				seen.get("--session-id"),
			),
		"invalid_launcher",
	);
	let settings;
	try {
		settings = JSON.parse(seen.get("--settings"));
	} catch {
		throw new Error("invalid_launcher");
	}
	check(
		object(settings) &&
			object(settings.enabledPlugins) &&
			settings.enabledPlugins["discord@flywheel-plugins"] === false &&
			settings.enabledPlugins["discord@claude-plugins-official"] === false,
		"invalid_launcher",
	);
	check(
		settings.model === undefined || settings.model === seen.get("--model"),
		"invalid_launcher",
	);
	return {
		model: seen.get("--model"),
		sessionId: seen.get("--session-id").toLowerCase(),
	};
}

function sanitizeServers(payload) {
	check(
		object(payload) && Array.isArray(payload.mcpServers),
		"invalid_mcp_status",
	);
	const servers = payload.mcpServers
		.map((server) => {
			check(
				object(server) && identifier(server.name, true),
				"invalid_mcp_status",
			);
			check(
				[
					"connected",
					"pending",
					"failed",
					"disconnected",
					"needs-auth",
					"disabled",
				].includes(server.status),
				"invalid_mcp_status",
			);
			check(
				server.tools === undefined || Array.isArray(server.tools),
				"invalid_mcp_status",
			);
			const tools = (server.tools ?? [])
				.map((tool) => {
					check(object(tool) && identifier(tool.name), "invalid_mcp_status");
					return { name: tool.name };
				})
				.sort((a, b) => a.name.localeCompare(b.name));
			check(
				new Set(tools.map((tool) => tool.name)).size === tools.length,
				"invalid_mcp_status",
			);
			return { name: server.name, status: server.status, tools };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	check(
		new Set(servers.map((server) => server.name)).size === servers.length,
		"invalid_mcp_status",
	);
	return servers;
}

function sanitizeContext(payload, model) {
	check(object(payload), "invalid_context");
	check(payload.model === model, "unexpected_model");
	const toolRows = (rows, mcp = false) => {
		if (rows === undefined) return undefined; // Omitted native detail stays unknown.
		check(Array.isArray(rows), "invalid_context");
		return rows.map((row) => {
			check(object(row) && identifier(row.name), "invalid_context");
			check(Number.isFinite(row.tokens) && row.tokens >= 0, "invalid_context");
			check(
				row.isLoaded === undefined || typeof row.isLoaded === "boolean",
				"invalid_context",
			);
			if (mcp) check(identifier(row.serverName, true), "invalid_context");
			return {
				name: row.name,
				tokens: row.tokens,
				...(mcp ? { serverName: row.serverName } : {}),
				...(row.isLoaded === undefined ? {} : { isLoaded: row.isLoaded }),
			};
		});
	};
	try {
		// Intentionally omit memory paths, account/source/agent/skill text, commands,
		// prompt sections, config and all other unprojected response properties.
		return summarizeClaudeContextDiagnostic({
			model,
			totalTokens: payload.totalTokens,
			categories: payload.categories,
			mcpTools: toolRows(payload.mcpTools, true),
			systemTools: toolRows(payload.systemTools),
			deferredBuiltinTools: toolRows(payload.deferredBuiltinTools),
		});
	} catch {
		throw new Error("invalid_context");
	}
}

/** Exact launcher args are validated, never rewritten. Only the listed flags
 * are accepted; positional prompts, resume and continue are rejected.
 * timeoutMs bounds collection; cleanup adds at most 3 * closeWaitMs.
 * Session reuse is checked within this process; caller must supply a UUID that
 * was not used in earlier processes. No session/auth directories are inspected.
 */
export async function probeClaudeContext(options, spawnChild = spawn) {
	const result = {
		purpose: "diagnostic-capability-only",
		roleBaseline: false,
		status: "failed",
		failure: null,
		context: null,
		mcpServers: [],
		mcpFingerprintBefore: null,
		mcpFingerprintAfter: null,
		protocol: {
			requests: 0,
			responses: 0,
			systemInit: 0,
			pendingPolls: 0,
			stdoutBytes: 0,
		},
		stderr: { bytes: 0, sha256: digest("") },
		cleanup: { closed: false, signals: [], exitCode: null },
	};
	let launch, canonicalCwd;
	const {
		binary,
		args,
		cwd,
		env = process.env,
		timeoutMs = 30000,
		controlTimeoutMs = 5000,
		closeWaitMs = 1000,
		pollIntervalMs = 250,
	} = options ?? {};
	try {
		launch = validateLauncher(binary, args);
		for (const [value, max] of [
			[timeoutMs, 120000],
			[controlTimeoutMs, 120000],
			[closeWaitMs, 5000],
			[pollIntervalMs, 1000],
		])
			check(
				Number.isInteger(value) && value > 0 && value <= max,
				"invalid_launcher",
			);
		check(object(env) && typeof spawnChild === "function", "invalid_launcher");
	} catch {
		result.failure = "invalid_launcher";
		return result;
	}
	try {
		check(
			typeof cwd === "string" && isAbsolute(cwd) && slotPath(resolve(cwd)),
			"invalid_cwd",
		);
		canonicalCwd = await realpath(cwd);
		check(
			slotPath(canonicalCwd) && (await stat(canonicalCwd)).isDirectory(),
			"invalid_cwd",
		);
	} catch {
		result.failure = "invalid_cwd";
		return result;
	}
	if (usedSessions.has(launch.sessionId)) {
		result.failure = "session_reused";
		return result;
	}
	usedSessions.add(launch.sessionId);
	let child;
	try {
		child = spawnChild(binary, [...args], {
			cwd: canonicalCwd,
			env,
			shell: false,
			detached: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		result.failure = "spawn_error";
		return result;
	}
	let failure = null,
		pending = null,
		closed = false,
		closing = false,
		collected = false;
	let resolveClosed;
	const closedPromise = new Promise((resolveClose) => {
		resolveClosed = resolveClose;
	});
	const fail = (code) => {
		failure ??= code;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(failure));
			pending = null;
		}
	};
	const stderrHash = createHash("sha256");
	const onStderr = (chunk) => {
		result.stderr.bytes += Buffer.byteLength(chunk);
		stderrHash.update(chunk);
	};
	child.stderr.on("data", onStderr);
	child.on("error", () => fail("spawn_error"));
	for (const stream of [child.stdin, child.stdout, child.stderr])
		stream.on("error", () => fail("stream_error"));
	child.on("close", (code) => {
		closed = true;
		result.cleanup.closed = true;
		result.cleanup.exitCode = Number.isInteger(code) ? code : null;
		if (!closing) fail(code === 0 ? "unexpected_exit" : "nonzero_exit");
		resolveClosed();
	});
	const overallTimer = setTimeout(() => fail("overall_timeout"), timeoutMs);
	let buffered = "";
	const decoder = new StringDecoder("utf8");
	const onStdout = (chunk) => {
		result.protocol.stdoutBytes += Buffer.byteLength(chunk);
		if (result.protocol.stdoutBytes > MAX_STDOUT_BYTES) {
			fail("stdout_limit");
			return;
		}
		if (failure) return;
		buffered += decoder.write(chunk);
		while (!failure) {
			const newline = buffered.indexOf("\n");
			if (newline === -1) break;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!line.trim()) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				fail("malformed_response");
				break;
			}
			if (!object(frame)) {
				fail("malformed_response");
				break;
			}
			if (
				["user", "assistant", "result", "stream_event"].includes(frame.type)
			) {
				fail("unexpected_turn");
				break;
			}
			if (frame.type === "system" && frame.subtype === "init") {
				result.protocol.systemInit++;
				if (frame.model !== launch.model) fail("unexpected_model");
				if (
					frame.session_id !== undefined &&
					frame.session_id.toLowerCase?.() !== launch.sessionId
				)
					fail("unexpected_session");
				continue;
			}
			if (frame.type !== "control_response" || !object(frame.response)) {
				fail("malformed_response");
				break;
			}
			const response = frame.response;
			if (typeof response.request_id !== "string" || !response.request_id) {
				fail("missing_request_id");
				break;
			}
			if (!pending || response.request_id !== pending.id) {
				fail("unexpected_request_id");
				break;
			}
			if (response.subtype === "error") {
				fail("control_error");
				break;
			}
			if (response.subtype !== "success" || !object(response.response)) {
				fail("malformed_response");
				break;
			}
			result.protocol.responses++;
			const request = pending;
			clearTimeout(request.timer);
			pending = null;
			request.resolve(response.response);
		}
	};
	child.stdout.on("data", onStdout);
	child.stdout.on("end", () => {
		if (buffered.trim() && !failure) fail("malformed_response");
	});
	const control = (subtype, extra = {}) => {
		if (failure) return Promise.reject(new Error(failure));
		return new Promise((resolveResponse, reject) => {
			const id = randomUUID();
			pending = {
				id,
				resolve: resolveResponse,
				reject,
				timer: setTimeout(() => fail("control_timeout"), controlTimeoutMs),
			};
			result.protocol.requests++;
			try {
				child.stdin.write(
					`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...extra } })}\n`,
				);
			} catch {
				fail("stream_error");
			}
		});
	};
	const settledServers = async () => {
		for (;;) {
			const servers = sanitizeServers(await control("mcp_status"));
			if (!servers.some((server) => server.status === "pending"))
				return servers;
			result.protocol.pendingPolls++;
			await new Promise((resolvePoll) =>
				setTimeout(resolvePoll, pollIntervalMs),
			);
		}
	};
	try {
		await control("initialize");
		result.mcpServers = await settledServers();
		result.mcpFingerprintBefore = digest(JSON.stringify(result.mcpServers));
		const context = sanitizeContext(
			await control("get_context_usage", { detail: "full" }),
			launch.model,
		);
		const after = await settledServers();
		result.mcpFingerprintAfter = digest(JSON.stringify(after));
		check(
			result.mcpFingerprintBefore === result.mcpFingerprintAfter,
			"unstable_mcp",
		);
		result.context = context;
		collected = true;
	} catch (error) {
		// All errors raised above are fixed codes; never copy a child error message.
		const codes = [
			"invalid_mcp_status",
			"invalid_context",
			"unexpected_model",
			"unstable_mcp",
		];
		failure ??= codes.includes(error.message)
			? error.message
			: "protocol_failed";
	} finally {
		clearTimeout(overallTimer);
		if (pending) {
			clearTimeout(pending.timer);
			pending = null;
		}
		closing = true;
		const waitForClose = async () => {
			if (closed) return;
			let timer;
			await Promise.race([
				closedPromise,
				new Promise((resolveWait) => {
					timer = setTimeout(resolveWait, closeWaitMs);
				}),
			]);
			clearTimeout(timer);
		};
		try {
			child.stdin.end();
		} catch {
			failure ??= "stream_error";
		}
		await waitForClose();
		for (const signal of ["SIGTERM", "SIGKILL"]) {
			if (closed) break;
			result.cleanup.signals.push(signal);
			try {
				child.kill(signal);
			} catch {
				/* bounded close still determines proof */
			}
			await waitForClose();
		}
		if (!closed) failure = "cleanup_unconfirmed";
		else if (result.cleanup.signals.length) failure ??= "cleanup_required_kill";
		else if (result.cleanup.exitCode !== 0) failure ??= "nonzero_exit";
		child.stdout.off("data", onStdout);
		child.stderr.off("data", onStderr);
		for (const stream of [child.stdin, child.stdout, child.stderr])
			stream.destroy();
		result.stderr.sha256 = stderrHash.digest("hex");
	}
	if (failure || !collected) {
		result.failure = failure ?? "protocol_failed";
		result.context = null;
	} else if (
		result.mcpServers.some((server) => server.status !== "connected")
	) {
		result.status = "incomplete";
		result.failure = "mcp_not_connected";
	} else result.status = "complete";
	return result;
}
