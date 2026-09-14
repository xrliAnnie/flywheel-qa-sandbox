import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeOptionalBearer, withMkdirLock } from "flywheel-config";

export const VALID_STAGES = new Set([
	"started",
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"implement",
	"test",
	"code_review",
	"pr_created",
	"approve",
	"ship",
	"completed",
]);

export interface StageEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	source: string;
	payload: { stage: string; [key: string]: unknown };
}

interface StageTransport {
	bridgeUrl: string;
	headers: Record<string, string>;
	retryPath?: string;
}

export function stageQueueTransportFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): StageTransport {
	const token = normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
	return {
		bridgeUrl: env.FLYWHEEL_BRIDGE_URL ?? "",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	};
}

export async function preflightStageQueue(
	execId: string | undefined,
	overtake = false,
): Promise<void> {
	if (!execId?.trim()) return;
	try {
		const dir = stageQueueDirectory(execId.trim());
		if (!existsSync(dir)) return;
		try {
			await flushStageQueue(execId.trim(), stageQueueTransportFromEnv());
		} catch (error) {
			console.error(
				`[flywheel-comm] stage replay deferred: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const pending = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort();
		const oldest = pending[0];
		if (overtake && oldest) {
			let stage = "unknown";
			try {
				const row = JSON.parse(readFileSync(join(dir, oldest), "utf8"));
				if (typeof row.payload?.stage === "string") stage = row.payload.stage;
			} catch {
				/* The retained file is still pending when its payload is unreadable. */
			}
			console.error(
				`[flywheel-comm] STAGE_PENDING_OVERTAKE: ${pending.length} stage event(s) remain queued (oldest seq=${oldest.slice(0, 6)}, stage=${stage}); they will be replayed by the next flywheel-comm call for this execution`,
			);
		}
	} catch (error) {
		console.error(
			`[flywheel-comm] ${overtake ? "STAGE_PENDING_OVERTAKE" : "stage replay deferred"}: queue state unavailable (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

type DeliveryOutcome =
	| "landed"
	| "replayed"
	| "superseded"
	| "refused"
	| "pending"
	| "transient";
interface StageFlushResult {
	refused: string[];
	receipts: Record<string, "landed" | "replayed" | "superseded">;
}

async function postStageEvent(
	body: StageEvent,
	transport: StageTransport,
): Promise<DeliveryOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(
			`${transport.bridgeUrl.replace(/\/$/, "")}/events`,
			{
				method: "POST",
				headers: transport.headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			if ([400, 401, 403, 409].includes(response.status)) {
				console.error(
					`[flywheel-comm stage] refused: Bridge returned ${response.status}; evidence preserved`,
				);
				return "refused";
			}
			console.error(
				`[flywheel-comm stage] Warning: Bridge returned ${response.status}; event retained for replay`,
			);
			return "transient";
		}
		const receipt: unknown = JSON.parse(await response.text());
		if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
			return "transient";
		const ack = receipt as Record<string, unknown>;
		if (ack.ok !== true || ack.warning) return "transient";
		if (
			ack.applied === false ||
			(ack.duplicate === true &&
				ack.applied !== true &&
				ack.superseded !== true)
		)
			return "pending";
		return ack.duplicate === true
			? ack.superseded === true
				? "superseded"
				: "replayed"
			: "landed";
	} catch (error) {
		console.error(
			`[flywheel-comm stage] delivery failed: ${error instanceof Error ? error.message : String(error)}; event retained for replay`,
		);
		return "transient";
	} finally {
		clearTimeout(timer);
	}
}

async function flushStageQueueLocked(
	dir: string,
	execId: string,
	transport: StageTransport,
): Promise<StageFlushResult> {
	cleanupStageTemps(dir);
	const refused: string[] = [];
	const receipts: StageFlushResult["receipts"] = {};
	const files = readdirSync(dir)
		.filter((name) => /^\d{6}-.+\.json$/.test(name))
		.sort()
		.slice(0, 3);
	for (const name of files) {
		const path = join(dir, name);
		const { queued_at: _queuedAt, ...body } = JSON.parse(
			readFileSync(path, "utf8"),
		);
		validateStageEvent(body);
		if (name.slice(7, -5) !== body.event_id)
			throw new Error("stage queue event id mismatch");
		if (body.execution_id !== execId || body.event_type !== "stage_changed")
			throw new Error("stage queue binding mismatch");
		const attempts = path === transport.retryPath ? 3 : 1;
		let outcome: DeliveryOutcome = "transient";
		for (let attempt = 0; attempt < attempts; attempt++) {
			outcome = await postStageEvent(body, transport);
			if (outcome !== "transient") break;
			if (attempt + 1 < attempts)
				await new Promise((resolve) =>
					setTimeout(resolve, [2000, 5000][attempt]),
				);
		}
		if (
			outcome === "landed" ||
			outcome === "replayed" ||
			outcome === "superseded"
		) {
			unlinkSync(path);
			receipts[path] = outcome;
		} else if (outcome === "refused") {
			renameSync(path, `${path}.rejected-${new Date().toISOString()}`);
			refused.push(path);
		} else break;
	}
	return { refused, receipts };
}

export async function flushStageQueue(
	execId: string,
	transport: StageTransport,
): Promise<StageFlushResult> {
	const dir = stageQueueDirectory(execId);
	return withMkdirLock(
		join(dir, ".lock"),
		() => flushStageQueueLocked(dir, execId, transport),
		{ timeoutMs: 10_000 },
	);
}

export async function withStageQueueFence<T>(
	execId: string,
	transport: StageTransport,
	action: () => Promise<T>,
): Promise<{ settled: false } | { settled: true; value: T }> {
	let actionStarted = false;
	try {
		const dir = stageQueueDirectory(execId);
		mkdirSync(dir, { recursive: true });
		return await withMkdirLock(
			join(dir, ".lock"),
			async () => {
				await flushStageQueueLocked(dir, execId, {
					...transport,
					retryPath: undefined,
				});
				const pending = readdirSync(dir).filter((name) =>
					name.endsWith(".json"),
				);
				if (pending.length) {
					console.error(
						`[flywheel-comm] STAGE_PENDING: ${pending.length} stage event(s) not yet settled; retry after they drain`,
					);
					return { settled: false as const };
				}
				actionStarted = true;
				return { settled: true as const, value: await action() };
			},
			{ timeoutMs: 10_000 },
		);
	} catch (error) {
		if (actionStarted) throw error;
		console.error(
			`[flywheel-comm] STAGE_PENDING: queue could not be verified (${error instanceof Error ? error.message : String(error)})`,
		);
		return { settled: false };
	}
}

function validateStageEvent(input: unknown): asserts input is StageEvent {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("invalid stage queue record");
	const row = input as Record<string, unknown>;
	const allowed = new Set([
		"event_id",
		"execution_id",
		"issue_id",
		"project_name",
		"event_type",
		"source",
		"payload",
	]);
	if (
		Object.keys(row).some((key) => !allowed.has(key)) ||
		["event_id", "execution_id", "issue_id", "project_name"].some(
			(key) => typeof row[key] !== "string" || !row[key],
		) ||
		row.event_type !== "stage_changed" ||
		row.source !== "flywheel-comm" ||
		!/^[-a-zA-Z0-9._:]+$/.test(String(row.event_id))
	)
		throw new Error("invalid stage queue envelope");
	const payload = row.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new Error("invalid stage queue payload");
	const fields = payload as Record<string, unknown>;
	if (
		typeof fields.stage !== "string" ||
		!VALID_STAGES.has(fields.stage) ||
		Object.keys(fields).some(
			(key) => !["stage", "plan_path", "landing_status"].includes(key),
		)
	)
		throw new Error("invalid queued stage");
	if (
		fields.plan_path !== undefined &&
		(typeof fields.plan_path !== "string" ||
			fields.stage !== "design_review" ||
			fields.plan_path.startsWith("/") ||
			fields.plan_path.split("/").includes(".."))
	)
		throw new Error("invalid queued plan path");
	if (fields.landing_status !== undefined) {
		const landing = fields.landing_status;
		if (!landing || typeof landing !== "object" || Array.isArray(landing))
			throw new Error("invalid queued landing status");
		const value = landing as Record<string, unknown>;
		if (
			Object.keys(value).some(
				(key) => !["status", "prNumber", "mergeCommitSha"].includes(key),
			) ||
			(value.status !== undefined && typeof value.status !== "string") ||
			(value.prNumber !== undefined &&
				(!Number.isInteger(value.prNumber) || Number(value.prNumber) <= 0)) ||
			(value.mergeCommitSha !== undefined &&
				typeof value.mergeCommitSha !== "string")
		)
			throw new Error("invalid queued landing status fields");
	}
}

export function stageQueueDirectory(execId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(execId))
		throw new Error("invalid stage execution id");
	return join(
		process.env.HOME ?? homedir(),
		".flywheel",
		"state",
		"stage-queue",
		execId,
	);
}

function cleanupStageTemps(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!/^\.\d+\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) continue;
		const path = join(dir, name);
		const stat = lstatSync(path);
		if (stat.isFile() && Date.now() - stat.mtimeMs > 3_600_000)
			unlinkSync(path);
	}
}

/** Publish under the per-execution lock before any network operation. */
export async function enqueueStageEvent(event: StageEvent): Promise<string> {
	validateStageEvent(event);
	const dir = stageQueueDirectory(event.execution_id);
	mkdirSync(dir, { recursive: true });
	return withMkdirLock(
		join(dir, ".lock"),
		async () => {
			cleanupStageTemps(dir);
			const seq =
				readdirSync(dir).reduce((max, name) => {
					const match = /^(\d{6})-/.exec(name);
					return match ? Math.max(max, Number(match[1])) : max;
				}, 0) + 1;
			if (seq > 999999) throw new Error("stage queue sequence exhausted");
			const path = join(
				dir,
				`${String(seq).padStart(6, "0")}-${event.event_id}.json`,
			);
			const temp = join(dir, `.${seq}.${process.pid}.${randomUUID()}.tmp`);
			try {
				const fd = openSync(temp, "wx", 0o600);
				try {
					writeFileSync(
						fd,
						JSON.stringify({ ...event, queued_at: new Date().toISOString() }),
						"utf8",
					);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				renameSync(temp, path);
				return path;
			} finally {
				rmSync(temp, { force: true });
			}
		},
		{ timeoutMs: 10_000 },
	);
}
