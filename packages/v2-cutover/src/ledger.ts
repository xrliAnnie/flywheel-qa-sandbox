import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { CUTOVER_STEPS } from "./steps.js";

type StepStatus = "started" | "done" | "failed";
type PrimitiveStatus = "intent" | "apply" | "verify" | "complete" | "failed";

interface LedgerPayload {
	kind: "step" | "primitive";
	step: number;
	title: string;
	status: StepStatus | PrimitiveStatus;
	evidence?: string[];
	primitiveKey?: string;
	description?: string;
	preimage?: unknown;
	at: string;
}

interface LedgerLine {
	seq: number;
	previousDigest: string | null;
	payload: LedgerPayload;
	digest: string;
}

export interface PrimitiveState {
	step: number;
	description: string;
	status: PrimitiveStatus;
	preimage?: unknown;
}

export interface ManualAdjudicationRecord {
	v: 1;
	windowId: string;
	epoch: number;
	sourceKind: "discord" | "legacy-comm" | "legacy-json";
	sourceId: string;
	payloadDigest: string;
	disposition: "migrate" | "dead" | "tombstone";
	reason: string;
	originalReason: string;
}

const MANUAL_ADJUDICATION_PREFIX = "manual-adjudication:";

function requireManualAdjudication(value: unknown): ManualAdjudicationRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("manual adjudication ledger payload is malformed");
	}
	const record = value as Partial<ManualAdjudicationRecord>;
	if (
		record.v !== 1 ||
		typeof record.windowId !== "string" ||
		record.windowId.trim().length === 0 ||
		!Number.isSafeInteger(record.epoch) ||
		(record.epoch ?? 0) <= 0 ||
		(record.sourceKind !== "discord" &&
			record.sourceKind !== "legacy-comm" &&
			record.sourceKind !== "legacy-json") ||
		typeof record.sourceId !== "string" ||
		record.sourceId.trim().length === 0 ||
		typeof record.payloadDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.payloadDigest) ||
		(record.disposition !== "migrate" &&
			record.disposition !== "dead" &&
			record.disposition !== "tombstone") ||
		typeof record.reason !== "string" ||
		record.reason.trim().length === 0 ||
		typeof record.originalReason !== "string" ||
		record.originalReason.trim().length === 0
	) {
		throw new Error("manual adjudication ledger payload is malformed");
	}
	return structuredClone(record as ManualAdjudicationRecord);
}

function manualAdjudicationKey(record: ManualAdjudicationRecord): string {
	return `${MANUAL_ADJUDICATION_PREFIX}${createHash("sha256")
		.update(
			`${record.windowId}\0${record.epoch}\0${record.sourceKind}\0${record.sourceId}`,
		)
		.digest("hex")}`;
}

function digest(
	seq: number,
	previousDigest: string | null,
	payload: LedgerPayload,
): string {
	return createHash("sha256")
		.update(JSON.stringify({ seq, previousDigest, payload }))
		.digest("hex");
}

function stepTitle(step: number): string {
	const found = CUTOVER_STEPS.find((entry) => entry.step === step);
	if (!found) throw new TypeError("step must be an integer in 1..9");
	return found.title;
}

export class CutoverLedger {
	readonly #dir: string;
	readonly #path: string;
	readonly #lines: LedgerLine[];

	constructor(dir: string) {
		if (!isAbsolute(dir)) throw new TypeError("ledgerDir must be absolute");
		this.#dir = dir;
		this.#path = join(dir, "ledger.jsonl");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		this.#lines = this.#load();
	}

	#load(): LedgerLine[] {
		if (!existsSync(this.#path)) return [];
		let previous: string | null = null;
		const lines: LedgerLine[] = [];
		const raw = readFileSync(this.#path, "utf8");
		for (const [index, text] of raw.split("\n").entries()) {
			if (text.length === 0) continue;
			let line: LedgerLine;
			try {
				line = JSON.parse(text) as LedgerLine;
			} catch {
				throw new Error(`cutover ledger malformed at line ${index + 1}`);
			}
			if (
				line.seq !== lines.length + 1 ||
				line.previousDigest !== previous ||
				line.digest !== digest(line.seq, line.previousDigest, line.payload)
			) {
				throw new Error(
					`cutover ledger malformed hash chain at line ${index + 1}`,
				);
			}
			stepTitle(line.payload.step);
			lines.push(line);
			previous = line.digest;
		}
		return lines;
	}

	#append(payload: LedgerPayload): LedgerLine {
		const seq = this.#lines.length + 1;
		const previousDigest = this.#lines[this.#lines.length - 1]?.digest ?? null;
		const line: LedgerLine = {
			seq,
			previousDigest,
			payload,
			digest: digest(seq, previousDigest, payload),
		};
		const prior = existsSync(this.#path)
			? readFileSync(this.#path)
			: Buffer.alloc(0);
		const temporary = join(this.#dir, `.ledger-${process.pid}-${seq}.tmp`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, prior);
			writeFileSync(fd, `${JSON.stringify(line)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, this.#path);
		chmodSync(this.#path, 0o600);
		const dirFd = openSync(this.#dir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		this.#lines.push(line);
		return line;
	}

	step(step: number, status: StepStatus, evidence: string[]): LedgerLine {
		const title = stepTitle(step);
		const existing = [...this.#lines]
			.reverse()
			.find(
				(line) => line.payload.kind === "step" && line.payload.step === step,
			);
		if (existing?.payload.status === "done") return existing;
		return this.#append({
			kind: "step",
			step,
			title,
			status,
			evidence: [...evidence],
			at: new Date().toISOString(),
		});
	}

	isStepDone(step: number): boolean {
		stepTitle(step);
		return this.#lines.some(
			(line) =>
				line.payload.kind === "step" &&
				line.payload.step === step &&
				line.payload.status === "done",
		);
	}

	primitive(
		key: string,
		step: number,
		description: string,
		status: PrimitiveStatus,
		preimage?: unknown,
	): LedgerLine & { replayed?: true } {
		if (key.trim().length === 0 || description.trim().length === 0) {
			throw new TypeError("primitive key and description are required");
		}
		const current = this.primitiveState(key);
		if (current?.status === "complete") {
			if (status !== "complete") {
				throw new Error(`primitive ${key} is already complete`);
			}
			const line = [...this.#lines]
				.reverse()
				.find(
					(entry) =>
						entry.payload.kind === "primitive" &&
						entry.payload.primitiveKey === key,
				);
			if (!line) throw new Error("primitive ledger state disappeared");
			return { ...line, replayed: true };
		}
		const allowed: Record<PrimitiveStatus, PrimitiveStatus[]> = {
			intent: ["intent", "apply", "failed"],
			apply: ["apply", "verify", "failed"],
			verify: ["verify", "complete", "failed"],
			complete: ["complete"],
			failed: ["intent", "apply", "failed"],
		};
		if (current && !allowed[current.status].includes(status)) {
			throw new Error(
				`primitive ${key} transition ${current.status} -> ${status} is invalid`,
			);
		}
		if (!current && status !== "intent") {
			throw new Error(`primitive ${key} must start at intent`);
		}
		return this.#append({
			kind: "primitive",
			step,
			title: stepTitle(step),
			status,
			primitiveKey: key,
			description,
			...(status === "intent" ? { preimage } : {}),
			at: new Date().toISOString(),
		});
	}

	primitiveState(key: string): PrimitiveState | null {
		let state: PrimitiveState | null = null;
		let retainedPreimage: unknown;
		for (const line of this.#lines) {
			const payload = line.payload;
			if (payload.kind !== "primitive" || payload.primitiveKey !== key) {
				continue;
			}
			if (payload.preimage !== undefined) {
				retainedPreimage = payload.preimage;
			}
			state = {
				step: payload.step,
				description: payload.description ?? "",
				status: payload.status as PrimitiveStatus,
				...(retainedPreimage !== undefined
					? { preimage: retainedPreimage }
					: {}),
			};
		}
		return state;
	}

	recordManualAdjudication(
		input: ManualAdjudicationRecord,
	): ManualAdjudicationRecord {
		const record = requireManualAdjudication(input);
		const key = manualAdjudicationKey(record);
		const description = `manual adjudication ${record.sourceKind}/${record.sourceId}`;
		let current = this.primitiveState(key);
		if (current?.preimage !== undefined) {
			const existing = requireManualAdjudication(current.preimage);
			if (JSON.stringify(existing) !== JSON.stringify(record)) {
				throw new Error(
					`manual adjudication conflicts with the ledger for ${record.sourceKind}/${record.sourceId}`,
				);
			}
		}
		if (current?.status === "complete") return record;
		if (!current || current.status === "failed") {
			this.primitive(key, 5, description, "intent", record);
			current = this.primitiveState(key);
		}
		if (current?.status === "intent") {
			this.primitive(key, 5, description, "apply");
			current = this.primitiveState(key);
		}
		if (current?.status === "apply") {
			this.primitive(key, 5, description, "verify");
			current = this.primitiveState(key);
		}
		if (current?.status === "verify") {
			this.primitive(key, 5, description, "complete");
			current = this.primitiveState(key);
		}
		if (current?.status !== "complete") {
			throw new Error(
				`manual adjudication did not reach complete for ${record.sourceKind}/${record.sourceId}`,
			);
		}
		return record;
	}

	manualAdjudications(): ManualAdjudicationRecord[] {
		const keys = new Set<string>();
		for (const line of this.#lines) {
			if (
				line.payload.kind === "primitive" &&
				line.payload.primitiveKey?.startsWith(MANUAL_ADJUDICATION_PREFIX)
			) {
				keys.add(line.payload.primitiveKey);
			}
		}
		return [...keys]
			.flatMap((key) => {
				const state = this.primitiveState(key);
				return state?.status === "complete"
					? [requireManualAdjudication(state.preimage)]
					: [];
			})
			.sort((left, right) =>
				`${left.sourceKind}\0${left.sourceId}`.localeCompare(
					`${right.sourceKind}\0${right.sourceId}`,
				),
			);
	}
}
