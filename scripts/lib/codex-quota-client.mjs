import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TAIL = 4096,
	WAIT_MS = 1800000,
	POLL_MS = 15000;
/** Accept complete error records only; prose containing JSON is not an error record. */
export function classifyQuotaTail(text) {
	if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TAIL)
		return undefined;
	for (const line of text.split("\n")) {
		const value = line.trim();
		if (!value) continue;
		if (value.startsWith("{")) {
			let event;
			try {
				event = JSON.parse(value);
			} catch {
				continue;
			}
			if (!event || !["error", "turn.failed"].includes(event.type)) continue;
			const code =
				event.error?.code ??
				event.code ??
				event.error?.codexErrorInfo ??
				event.codexErrorInfo;
			if (code === "usageLimitExceeded") return code;
			const message = event.error?.message ?? event.message;
			if (
				typeof message === "string" &&
				/^You(?:'|’)ve hit your usage limit\.(?:\s|$)/u.test(message)
			)
				return "usageLimited";
		} else if (/^You(?:'|’)ve hit your usage limit\.(?:\s|$)/u.test(value))
			return "usageLimited";
	}
	return undefined;
}

/** Dependencies make wait time distinct from execution time and keep fixtures hermetic. */
export function explicitReviewModel(args) {
	let model;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "--profile" || arg === "-p" || arg.startsWith("--profile="))
			throw new Error("ambiguous_review_model");
		if (arg === "-c" || arg === "--config") {
			const config = args[++i] ?? "";
			if (/^\s*model\s*=/.test(config))
				throw new Error("ambiguous_review_model");
			continue;
		}
		if (/^--config=\s*model\s*=/.test(arg))
			throw new Error("ambiguous_review_model");
		if (arg === "-m" || arg === "--model" || arg.startsWith("--model=")) {
			if (model !== undefined) throw new Error("ambiguous_review_model");
			model = arg.startsWith("--model=") ? arg.slice(8) : args[++i];
			if (
				typeof model !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)
			)
				throw new Error("invalid_review_model");
		}
	}
	if (!model) throw new Error("missing_review_model");
	return model;
}
/** Enrollment is additive: unrelated runner-pane commands retain the local CLI lane. */
export function canEnrollQuotaReview(env, args) {
	try {
		if (
			![env.FLYWHEEL_EXEC_ID, env.FLYWHEEL_PROJECT_NAME].every(
				(value) =>
					typeof value === "string" && /^[-A-Za-z0-9:_]{1,512}$/.test(value),
			) ||
			typeof env.FLYWHEEL_INGEST_TOKEN !== "string" ||
			!env.FLYWHEEL_INGEST_TOKEN.trim()
		)
			return false;
		const url = new URL(env.FLYWHEEL_BRIDGE_URL);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password
		)
			return false;
		explicitReviewModel(args);
		return true;
	} catch {
		return false;
	}
}
export async function runReview(deps) {
	let current = await deps.bind(),
		waitSpent = 0,
		waitFailure = "CODEX_QUOTA_WAIT_EXPIRED";
	const waitReady = async () => {
		const started = deps.now();
		try {
			while (true) {
				if (waitSpent + deps.now() - started > WAIT_MS) return false;
				if (current.state === "ready") {
					if (current.generation === current.binding.generation) return true;
					const expected = current.generation;
					current = await deps.bind();
					if (
						current.generation < expected ||
						current.binding.generation !== current.generation
					) {
						waitFailure = "CODEX_QUOTA_CONTROLLED_FAILURE";
						return false;
					}
					continue;
				}
				if (current.state === "probe_failed" || current.state === "abandoned") {
					waitFailure =
						current.state === "probe_failed"
							? "CODEX_QUOTA_PROBE_FAILED"
							: "CODEX_QUOTA_ABANDONED";
					return false;
				}
				if (waitSpent + deps.now() - started >= WAIT_MS) return false;
				await deps.sleep(
					Math.min(POLL_MS, WAIT_MS - waitSpent - (deps.now() - started)),
				);
				current = {
					...current,
					...(await deps.status(current.binding.bindingId)),
				};
			}
		} finally {
			waitSpent += deps.now() - started;
		}
	};
	const fail = async (marker = waitFailure) => {
		deps.marker?.(marker);
		await deps.abandon?.(current.binding.bindingId);
		return 75;
	};
	if (!(await waitReady())) return fail();
	let waitingBinding;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt === 1 && waitingBinding) {
			const permit = await deps.status(waitingBinding);
			if (
				permit.state !== "ready" ||
				permit.generation !== current.binding.generation
			)
				return fail("CODEX_QUOTA_CONTROLLED_FAILURE");
		}
		const result = await deps.execute(
			attempt === 0 ? (deps.initialBudget ?? 1800) : 1800,
		);
		if (attempt === 1 && waitingBinding)
			await deps.resumed?.(waitingBinding, current.binding.bindingId);
		if (result.code === 0 || result.code === 124) return result.code;
		const evidence = classifyQuotaTail(result.tail);
		if (!evidence) return result.code;
		const signal = {
			version: 1,
			vendor: "codex",
			source: "review_exec",
			sourceEventId: randomUUID(),
			bindingId: current.binding.bindingId,
			evidence,
			observedAt: new Date().toISOString(),
		};
		waitingBinding = signal.bindingId;
		await deps.spool(signal);
		await deps.observe(signal);
		await deps.ack(signal);
		if (attempt === 1) return fail("CODEX_QUOTA_RETRY_EXHAUSTED");
		current = { ...current, ...(await deps.status(current.binding.bindingId)) };
		if (!(await waitReady())) return fail();
		// An unpaused response for the exhausted generation cannot authorize another exec.
		if (current.binding.bindingId === signal.bindingId)
			return fail("CODEX_QUOTA_CONTROLLED_FAILURE");
	}
	return 75;
}

function safeRead(path, limit) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error("unsafe_file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
function secureDir(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
		throw new Error("unsafe_spool");
}
function durableWrite(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const dir = openSync(dirname(path), constants.O_RDONLY);
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}
function validateResponse(value) {
	if (
		!value ||
		!["ready", "paused", "probe_failed", "abandoned"].includes(value.state) ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0
	)
		throw new Error("invalid_quota_response");
	return value;
}
async function main() {
	const env = process.env,
		executionId = env.FLYWHEEL_EXEC_ID,
		projectName = env.FLYWHEEL_PROJECT_NAME,
		token = env.FLYWHEEL_INGEST_TOKEN;
	const wrapper = process.argv[2],
		args = process.argv.slice(3);
	if (
		!executionId ||
		!projectName ||
		!token ||
		!wrapper ||
		!isAbsolute(wrapper)
	)
		throw new Error("missing_quota_identity");
	const url = new URL(env.FLYWHEEL_BRIDGE_URL);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password
	)
		throw new Error("invalid_bridge");
	const spoolRoot =
		env.FLYWHEEL_CODEX_QUOTA_SPOOL_DIR ??
		join(homedir(), ".flywheel", "codex-quota", "spool");
	if (!isAbsolute(spoolRoot)) throw new Error("invalid_spool");
	secureDir(spoolRoot);
	const scope = createHash("sha256")
		.update(`${executionId}:${projectName}`)
		.digest("hex");
	const pathFor = (signal) =>
		join(spoolRoot, `${scope}-${signal.sourceEventId}.json`);
	let boundAuthDigest,
		bindingId,
		activeChild,
		invocations = 0;
	let managedReview = false;
	const localFallback = () =>
		new Promise((resolve, reject) => {
			process.stderr.write("CODEX_QUOTA_API_UNAVAILABLE_LOCAL_FALLBACK\n");
			activeChild = spawn("/bin/bash", [wrapper, ...args], {
				env: { ...env, FLYWHEEL_CODEX_QUOTA_CHILD: "1" },
				stdio: "inherit",
			});
			activeChild.once("error", reject);
			activeChild.once("exit", (code, signal) => {
				activeChild = undefined;
				resolve(code ?? (signal === "SIGINT" ? 130 : 143));
			});
		});
	const request = async (path, body) => {
		try {
			const response = await fetch(new URL(`/api/codex/quota/${path}`, url), {
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) throw new Error("quota_api_refused");
			const reader = response.body.getReader();
			let raw = "";
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				raw += Buffer.from(part.value).toString("utf8");
				if (Buffer.byteLength(raw) > 8192) {
					await reader.cancel();
					throw new Error("quota_response_oversize");
				}
			}
			return JSON.parse(raw);
		} catch (error) {
			// Before a valid binding exists this is optional enrollment. Preserve
			// spool records and the local CLI contract during Bridge outages.
			// Once bound, recovery and retry authorization remain fail-closed.
			if (!managedReview) error.localFallback = localFallback;
			throw error;
		}
	};
	const observe = async (signal) => {
		const ack = await request("observe", { executionId, projectName, signal });
		if (ack.accepted !== true)
			throw new Error("quota_observation_unacknowledged");
	};
	// A crashed caller leaves only typed quota facts; replay before admitting new work.
	for (const name of readdirSync(spoolRoot)) {
		if (!name.startsWith(`${scope}-`) || !name.endsWith(".json")) continue;
		const path = join(spoolRoot, name),
			signal = JSON.parse(safeRead(path, 8192));
		const keys = [
			"version",
			"vendor",
			"source",
			"sourceEventId",
			"bindingId",
			"evidence",
			"observedAt",
		];
		if (
			Object.keys(signal).length !== keys.length ||
			keys.some((k) => !(k in signal)) ||
			signal.version !== 1 ||
			signal.vendor !== "codex" ||
			signal.source !== "review_exec" ||
			!["usageLimited", "usageLimitExceeded"].includes(signal.evidence) ||
			![signal.sourceEventId, signal.bindingId].every(
				(v) => typeof v === "string" && /^[A-Za-z0-9:_-]{1,512}$/.test(v),
			) ||
			typeof signal.observedAt !== "string" ||
			signal.observedAt.length > 40 ||
			!Number.isFinite(Date.parse(signal.observedAt))
		)
			throw new Error("invalid_spool_record");
		await observe(signal);
		unlinkSync(path);
	}
	const abandon = async (id) => {
		if (id)
			await request("status", {
				executionId,
				projectName,
				bindingId: id,
				state: "abandoned",
			}).catch(() => {});
	};
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	])
		process.once(signal, () => {
			activeChild?.kill(signal);
			void abandon(bindingId).finally(() => process.exit(code));
		});
	const actualAuthDigest = () =>
		createHash("sha256")
			.update(
				safeRead(
					realpathSync(
						join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
					),
					1024 * 1024,
				),
			)
			.digest("hex");
	const model = explicitReviewModel(args);
	const invocationId = randomUUID();
	const configuredBudget = Math.min(
		Number(env.FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS ?? 1800),
		Number(env.FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS ?? 1800),
		1800,
	);
	if (!Number.isSafeInteger(configuredBudget) || configuredBudget <= 0)
		throw new Error("invalid_execution_budget");
	let result;
	try {
		result = await runReview({
			initialBudget: configuredBudget,
			marker: (value) => process.stderr.write(`${value}\n`),
			now: () => performance.now(),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			bind: async () => {
				const authDigest = actualAuthDigest();
				const bound = validateResponse(
					await request("bind", {
						executionId,
						projectName,
						invocationId: `${invocationId}:${invocations++}`,
						purpose: "review",
						model,
						authDigest,
					}),
				);
				if (
					!bound.binding ||
					typeof bound.binding.bindingId !== "string" ||
					!/^[-A-Za-z0-9:_]{1,512}$/.test(bound.binding.bindingId) ||
					bound.binding.executionId !== executionId ||
					bound.binding.purpose !== "review" ||
					bound.binding.generation !== bound.generation
				)
					throw new Error("invalid_quota_binding");
				managedReview = true;
				bindingId = bound.binding.bindingId;
				boundAuthDigest = authDigest;
				return bound;
			},
			status: async (id) =>
				validateResponse(
					await request(
						`status?${new URLSearchParams({ executionId, projectName, bindingId: id })}`,
					),
				),
			spool: async (signal) => durableWrite(pathFor(signal), signal),
			observe,
			ack: async (signal) => unlinkSync(pathFor(signal)),
			abandon,
			resumed: async (id, successorBindingId) => {
				await request("status", {
					executionId,
					projectName,
					bindingId: id,
					state: "resumed",
					successorBindingId,
				}).catch(() => {});
			},
			execute: (budget) =>
				new Promise((resolveAttempt, reject) => {
					if (actualAuthDigest() !== boundAuthDigest)
						throw new Error("quota_auth_drift");
					let tail = Buffer.alloc(0);
					activeChild = spawn("/bin/bash", [wrapper, ...args], {
						env: {
							...env,
							FLYWHEEL_CODEX_QUOTA_CHILD: "1",
							FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS: String(budget),
							FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS: String(budget),
						},
						stdio: ["inherit", "pipe", "pipe"],
					});
					const capture = (stream, output) =>
						stream.on("data", (chunk) => {
							output.write(chunk);
							tail = Buffer.concat([tail, chunk]);
							if (tail.length > MAX_TAIL)
								tail = tail.subarray(tail.length - MAX_TAIL);
						});
					capture(activeChild.stdout, process.stdout);
					capture(activeChild.stderr, process.stderr);
					activeChild.once("error", reject);
					activeChild.once("exit", (code, signal) => {
						activeChild = undefined;
						resolveAttempt({
							code: code ?? (signal === "SIGINT" ? 130 : 143),
							tail: tail.toString("utf8"),
						});
					});
				}),
		});
	} finally {
		await abandon(bindingId);
	}
	process.exitCode = result;
}
if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (process.argv[2] === "--check-review-enrollment")
		process.exitCode = canEnrollQuotaReview(process.env, process.argv.slice(3))
			? 0
			: 1;
	else
		main().catch(async (error) => {
			if (error.localFallback) {
				try {
					process.exitCode = await error.localFallback();
					return;
				} catch {
					/* A failed local spawn remains a controlled failure. */
				}
			}
			process.stderr.write("CODEX_QUOTA_CONTROLLED_FAILURE\n");
			process.exitCode = 75;
		});
}
