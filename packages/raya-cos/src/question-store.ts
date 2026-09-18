import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LeadRef } from "./ports.js";

export type StoredQuestionStatus =
	| "posting"
	| "posted"
	| "answer_observed"
	| "delivered"
	| "expired"
	| "failed";

export interface StoredLeadQuestion {
	askId: string;
	status: StoredQuestionStatus;
	to: LeadRef;
	recipientUserId: string;
	displayName: string;
	question: string;
	sourceMessageId: string;
	createdAt: string;
	postedMessageId?: string;
	postedAt?: string;
	answerMessageId?: string;
	answerAuthorLeadId?: string;
	answerObservedAt?: string;
	answerReceiptMessageId?: string;
	deliveredMessageIds?: string[];
	finishedAt?: string;
	reason?: string;
	transportUnavailableReason?: "lead_transport_not_available";
}

export interface QuestionEvent {
	at: string;
	kind: string;
	[key: string]: string | number | boolean | null;
}

const STATUSES = new Set<StoredQuestionStatus>([
	"posting",
	"posted",
	"answer_observed",
	"delivered",
	"expired",
	"failed",
]);
const MESSAGE_ID = /^\d{17,20}$/;

function isQuestion(value: unknown): value is StoredLeadQuestion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const question = value as Record<string, unknown>;
	const to = question.to as Record<string, unknown> | undefined;
	return (
		typeof question.askId === "string" &&
		question.askId.length > 0 &&
		STATUSES.has(question.status as StoredQuestionStatus) &&
		!!to &&
		typeof to.project === "string" &&
		typeof to.leadId === "string" &&
		typeof question.recipientUserId === "string" &&
		MESSAGE_ID.test(question.recipientUserId) &&
		typeof question.displayName === "string" &&
		typeof question.question === "string" &&
		question.question.length > 0 &&
		typeof question.sourceMessageId === "string" &&
		MESSAGE_ID.test(question.sourceMessageId) &&
		typeof question.createdAt === "string" &&
		Number.isFinite(Date.parse(question.createdAt)) &&
		(question.transportUnavailableReason === undefined ||
			question.transportUnavailableReason === "lead_transport_not_available")
	);
}

/** Strict read-only decoder for migration. Original bytes are never moved here. */
export function parseStoredQuestions(source: string): StoredLeadQuestion[] {
	const value: unknown = JSON.parse(source);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as { v?: unknown }).v !== 1 ||
		!Array.isArray((value as { questions?: unknown }).questions)
	)
		throw new Error("invalid questions state");
	const rows = (value as { questions: unknown[] }).questions;
	if (rows.length > 10000 || !rows.every(isQuestion))
		throw new Error("invalid questions state");
	if (new Set(rows.map((row) => row.askId)).size !== rows.length)
		throw new Error("duplicate question identity");
	return rows;
}

export class QuestionStore {
	readonly root: string;
	private readonly questionsPath: string;
	private readonly eventsPath: string;

	constructor(
		stateDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.root = join(stateDir, "lead-questions");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
		this.questionsPath = join(this.root, "questions.json");
		this.eventsPath = join(this.root, "events.jsonl");
	}

	read(): StoredLeadQuestion[] {
		if (!existsSync(this.questionsPath)) return [];
		try {
			const parsed: unknown = JSON.parse(
				readFileSync(this.questionsPath, "utf8"),
			);
			const file = parsed as { v?: unknown; questions?: unknown };
			if (
				!parsed ||
				typeof parsed !== "object" ||
				file.v !== 1 ||
				!Array.isArray(file.questions) ||
				!file.questions.every(isQuestion)
			) {
				throw new Error("invalid questions state");
			}
			return file.questions;
		} catch {
			renameSync(
				this.questionsPath,
				`${this.questionsPath}.corrupt-${this.now()}`,
			);
			return [];
		}
	}

	write(questions: StoredLeadQuestion[]): void {
		if (!questions.every(isQuestion))
			throw new Error("invalid questions state");
		this.atomicJson(this.questionsPath, { v: 1, questions });
	}

	appendEvent(event: QuestionEvent): void {
		if (
			!event.kind ||
			!Number.isFinite(Date.parse(event.at)) ||
			Object.keys(event).some((key) =>
				/(?:content|text|input|question|answer|stderr)/iu.test(key),
			)
		) {
			throw new Error("question events must be metadata-only");
		}
		const descriptor = openSync(this.eventsPath, "a", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(event)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.eventsPath, 0o600);
	}

	private atomicJson(path: string, value: unknown): void {
		const temporary = `${path}.tmp-${process.pid}-${this.now()}`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporary, path);
			chmodSync(path, 0o600);
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if (existsSync(temporary)) unlinkSync(temporary);
			throw error;
		}
	}
}
