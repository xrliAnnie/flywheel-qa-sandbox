import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type VoiceMinutesSettlement =
	| { kind: "absent" }
	| { kind: "live" }
	| { kind: "archived_terminal" }
	| { kind: "archived_nonterminal" }
	| { kind: "torn_identity" };

export interface VoiceMinutesPayload {
	sessionId: string;
	leadId: string;
	projectName: string;
	threadId: string;
	voiceBotUserId: string;
	founderUserId: string;
	displayName: string;
	transcriptDigest: string;
	contextDigest: string;
	status: "complete" | "incomplete";
	facts: string[];
	decisions: string[];
	pending: string[];
	handoffs: Array<{ handoffId: string; state: string }>;
}

export interface VoiceMinutesJob {
	version: 1;
	jobId: string;
	deliveryId: string;
	payloadDigest: string;
	state: "pending" | "dispatching" | "delivered";
	attemptToken: string | null;
	createdAt: string;
	updatedAt: string;
	payload: VoiceMinutesPayload;
}

export interface VoiceMinutesQueueOptions {
	root: string;
	deliver: (
		job: VoiceMinutesJob,
		deliveryId: string,
	) => Promise<{ deliveryId: string }>;
	inspect: (
		deliveryId: string,
		job: VoiceMinutesJob,
	) => VoiceMinutesSettlement | Promise<VoiceMinutesSettlement>;
	now?: () => string;
}

function canonical(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.flatMap((key) => {
					const item = (value as Record<string, unknown>)[key];
					return item === undefined ? [] : [[key, canonical(item)]];
				}),
		);
	}
	throw new Error("voice_minutes_invalid");
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

function validId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePayload(payload: VoiceMinutesPayload): void {
	if (
		!payload ||
		typeof payload !== "object" ||
		Object.keys(payload).sort().join(",") !==
			"contextDigest,decisions,displayName,facts,founderUserId,handoffs,leadId,pending,projectName,sessionId,status,threadId,transcriptDigest,voiceBotUserId" ||
		!validId(payload.sessionId) ||
		!validId(payload.leadId) ||
		!validId(payload.projectName) ||
		!validId(payload.threadId) ||
		!validId(payload.voiceBotUserId) ||
		!validId(payload.founderUserId) ||
		typeof payload.displayName !== "string" ||
		payload.displayName.trim() === "" ||
		Buffer.byteLength(payload.displayName, "utf8") > 256 ||
		!/^[a-f0-9]{64}$/u.test(payload.transcriptDigest) ||
		!/^[a-f0-9]{64}$/u.test(payload.contextDigest) ||
		!new Set(["complete", "incomplete"]).has(payload.status)
	)
		throw new Error("voice_minutes_invalid");
	for (const values of [payload.facts, payload.decisions, payload.pending]) {
		if (
			!Array.isArray(values) ||
			values.length > 256 ||
			values.some(
				(value) =>
					typeof value !== "string" ||
					Buffer.byteLength(value, "utf8") > 8 * 1024,
			)
		)
			throw new Error("voice_minutes_invalid");
	}
	if (
		!Array.isArray(payload.handoffs) ||
		payload.handoffs.length > 256 ||
		payload.handoffs.some(
			(item) =>
				!item ||
				typeof item !== "object" ||
				Object.keys(item).sort().join(",") !== "handoffId,state" ||
				!validId(item.handoffId) ||
				!validId(item.state),
		)
	)
		throw new Error("voice_minutes_invalid");
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 256 * 1024)
		throw new Error("voice_minutes_invalid");
}

export class VoiceMinutesQueue {
	private readonly now: () => string;

	constructor(private readonly options: VoiceMinutesQueueOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		mkdirSync(options.root, { recursive: true, mode: 0o700 });
		chmodSync(options.root, 0o700);
	}

	enqueue(payload: VoiceMinutesPayload): VoiceMinutesJob {
		validatePayload(payload);
		const jobId = digest({
			version: 1,
			sessionId: payload.sessionId,
			transcriptDigest: payload.transcriptDigest,
		});
		const payloadDigest = digest(payload);
		const prior = this.read(jobId);
		if (prior) {
			if (prior.payloadDigest !== payloadDigest)
				throw new Error("voice_minutes_idempotency_conflict");
			return prior;
		}
		const at = this.now();
		const job: VoiceMinutesJob = {
			version: 1,
			jobId,
			deliveryId: `chat:${payload.leadId}:voice-minutes-${jobId}`,
			payloadDigest,
			state: "pending",
			attemptToken: null,
			createdAt: at,
			updatedAt: at,
			payload,
		};
		this.write(job);
		return job;
	}

	prepareNext(): VoiceMinutesJob | undefined {
		const next = this.list().find((job) => job.state !== "delivered");
		if (!next) return;
		if (next.state === "dispatching") return next;
		const claimed: VoiceMinutesJob = {
			...next,
			state: "dispatching",
			attemptToken: randomUUID(),
			updatedAt: this.now(),
		};
		this.write(claimed);
		return claimed;
	}

	async drainOne(): Promise<VoiceMinutesJob | undefined> {
		const job = this.prepareNext();
		if (!job) return;
		const settlement = await this.options.inspect(job.deliveryId, job);
		if (
			settlement.kind === "live" ||
			settlement.kind === "archived_terminal" ||
			settlement.kind === "archived_nonterminal"
		) {
			return this.delivered(job);
		}
		if (settlement.kind === "torn_identity")
			throw new Error("voice_minutes_delivery_identity_torn");
		const receipt = await this.options.deliver(job, job.deliveryId);
		if (receipt.deliveryId !== job.deliveryId)
			throw new Error("voice_minutes_delivery_receipt_mismatch");
		return this.delivered(job);
	}

	async drainAll(limit = 100): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
			throw new Error("voice_minutes_drain_limit_invalid");
		let drained = 0;
		while (drained < limit) {
			const job = await this.drainOne();
			if (!job) break;
			drained += 1;
		}
		return drained;
	}

	private delivered(job: VoiceMinutesJob): VoiceMinutesJob {
		const result: VoiceMinutesJob = {
			...job,
			state: "delivered",
			attemptToken: null,
			updatedAt: this.now(),
		};
		this.write(result);
		return result;
	}

	private list(): VoiceMinutesJob[] {
		return readdirSync(this.options.root)
			.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
			.map((name) =>
				this.decode(
					readFileSync(join(this.options.root, name), "utf8"),
					name.slice(0, -".json".length),
				),
			)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	private read(jobId: string): VoiceMinutesJob | undefined {
		const path = this.path(jobId);
		if (!existsSync(path)) return;
		return this.decode(readFileSync(path, "utf8"), jobId);
	}

	private decode(encoded: string, expectedJobId: string): VoiceMinutesJob {
		let value: unknown;
		try {
			value = JSON.parse(encoded);
		} catch {
			throw new Error("voice_minutes_job_corrupt");
		}
		if (
			!isObject(value) ||
			Object.keys(value).sort().join(",") !==
				"attemptToken,createdAt,deliveryId,jobId,payload,payloadDigest,state,updatedAt,version" ||
			value.version !== 1 ||
			value.jobId !== expectedJobId ||
			typeof value.payloadDigest !== "string" ||
			!SHA256_PATTERN.test(value.payloadDigest) ||
			!new Set(["pending", "dispatching", "delivered"]).has(
				String(value.state),
			) ||
			(value.attemptToken !== null &&
				(typeof value.attemptToken !== "string" ||
					!validId(value.attemptToken))) ||
			typeof value.createdAt !== "string" ||
			!Number.isFinite(Date.parse(value.createdAt)) ||
			typeof value.updatedAt !== "string" ||
			!Number.isFinite(Date.parse(value.updatedAt))
		)
			throw new Error("voice_minutes_job_corrupt");
		try {
			validatePayload(value.payload as VoiceMinutesPayload);
		} catch {
			throw new Error("voice_minutes_job_corrupt");
		}
		const payload = value.payload as VoiceMinutesPayload;
		const calculatedJobId = digest({
			version: 1,
			sessionId: payload.sessionId,
			transcriptDigest: payload.transcriptDigest,
		});
		if (
			calculatedJobId !== expectedJobId ||
			value.payloadDigest !== digest(payload) ||
			value.deliveryId !==
				`chat:${payload.leadId}:voice-minutes-${expectedJobId}`
		)
			throw new Error("voice_minutes_job_corrupt");
		return value as unknown as VoiceMinutesJob;
	}

	private write(job: VoiceMinutesJob): void {
		const path = this.path(job.jobId);
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(job)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	}

	private path(jobId: string): string {
		return join(this.options.root, `${jobId}.json`);
	}
}
