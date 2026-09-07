import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type OncallBook = "runbook" | "contact-book";
export type OncallLane = "thread" | "mailbox";
export type OncallReceiptStage = "owed" | "pending" | "landed";

export interface OncallReceiptIdentity {
	book: OncallBook;
	lane: OncallLane;
	correlationKey: string;
	eventId: string;
	kind: string;
}

export interface OncallReceipt extends OncallReceiptIdentity {
	draftId: string;
	author?: string;
	body?: string;
	to?: string;
	ref?: string;
	createdAt: string;
	landedAt?: string;
}

export interface OncallReceiptResult {
	draftId: string;
	path: string;
	receipt: OncallReceipt;
}

export interface OncallReceiptStoreOptions {
	digest?: (identity: OncallReceiptIdentity) => string;
	afterTargetLink?: (
		operation: "owed_to_pending" | "pending_to_landed",
	) => void;
}

function identityTuple(identity: OncallReceiptIdentity): string {
	return JSON.stringify([
		identity.book,
		identity.lane,
		identity.correlationKey,
		identity.eventId,
		identity.kind,
	]);
}

function defaultDigest(identity: OncallReceiptIdentity): string {
	return createHash("sha256")
		.update(identityTuple(identity))
		.digest("hex")
		.slice(0, 16);
}

function readableKind(kind: string): string {
	return (
		kind
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "alert"
	);
}

export function draftIdForIdentity(
	identity: OncallReceiptIdentity,
	digest: (identity: OncallReceiptIdentity) => string = defaultDigest,
): string {
	const suffix = digest(identity);
	if (!/^[a-f0-9]{16}$/i.test(suffix)) {
		throw new Error("receipt_digest_invalid");
	}
	return `${identity.book}--${readableKind(identity.kind)}--${suffix.toLowerCase()}`;
}

function jsonLine(key: string, value: string): string {
	return `${key}: ${JSON.stringify(value)}`;
}

export function serializeOncallReceipt(receipt: OncallReceipt): string {
	return [
		"---",
		jsonLine("draft_id", receipt.draftId),
		jsonLine("book", receipt.book),
		jsonLine("lane", receipt.lane),
		jsonLine("correlation_key", receipt.correlationKey),
		jsonLine("event_id", receipt.eventId),
		jsonLine("kind", receipt.kind),
		...(receipt.author ? [jsonLine("author", receipt.author)] : []),
		...(receipt.to ? [jsonLine("to", receipt.to)] : []),
		...(receipt.ref ? [jsonLine("ref", receipt.ref)] : []),
		jsonLine("created_at", receipt.createdAt),
		...(receipt.landedAt ? [jsonLine("landed_at", receipt.landedAt)] : []),
		"---",
		receipt.body ?? "",
		"",
	].join("\n");
}

function parseJsonValue(raw: string): string {
	const value = JSON.parse(raw) as unknown;
	if (typeof value !== "string") throw new Error("receipt_frontmatter_invalid");
	return value;
}

export function parseOncallReceipt(markdown: string): OncallReceipt {
	const lines = markdown.split("\n");
	if (lines[0] !== "---") throw new Error("receipt_frontmatter_invalid");
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new Error("receipt_frontmatter_invalid");
	const values = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("receipt_frontmatter_invalid");
		const key = line.slice(0, separator);
		values.set(key, parseJsonValue(line.slice(separator + 1).trim()));
	}
	const required = [
		"draft_id",
		"book",
		"lane",
		"correlation_key",
		"event_id",
		"kind",
		"created_at",
	] as const;
	if (required.some((key) => !values.get(key))) {
		throw new Error("receipt_frontmatter_invalid");
	}
	const book = values.get("book");
	const lane = values.get("lane");
	if (
		(book !== "runbook" && book !== "contact-book") ||
		(lane !== "thread" && lane !== "mailbox")
	) {
		throw new Error("receipt_frontmatter_invalid");
	}
	const body = lines
		.slice(end + 1)
		.join("\n")
		.replace(/\n$/, "");
	return {
		draftId: values.get("draft_id") as string,
		book,
		lane,
		correlationKey: values.get("correlation_key") as string,
		eventId: values.get("event_id") as string,
		kind: values.get("kind") as string,
		createdAt: values.get("created_at") as string,
		...(values.get("author") ? { author: values.get("author") } : {}),
		...(values.get("to") ? { to: values.get("to") } : {}),
		...(values.get("ref") ? { ref: values.get("ref") } : {}),
		...(values.get("landed_at") ? { landedAt: values.get("landed_at") } : {}),
		...(body ? { body } : {}),
	};
}

function sameIdentity(
	left: OncallReceiptIdentity,
	right: OncallReceiptIdentity,
): boolean {
	return identityTuple(left) === identityTuple(right);
}

function semanticallyEqual(left: OncallReceipt, right: OncallReceipt): boolean {
	return (
		sameIdentity(left, right) &&
		(left.body ?? "") === (right.body ?? "") &&
		(left.to ?? "") === (right.to ?? "")
	);
}

function assertIdentity(identity: OncallReceiptIdentity): void {
	for (const value of [
		identity.correlationKey,
		identity.eventId,
		identity.kind,
	]) {
		if (!value.trim() || value.includes("\0")) {
			throw new Error("receipt_identity_invalid");
		}
	}
}

export class OncallReceiptStore {
	readonly root: string;
	private readonly digest: (identity: OncallReceiptIdentity) => string;

	constructor(
		root: string,
		private readonly options: OncallReceiptStoreOptions = {},
	) {
		this.root = resolve(root);
		this.digest = options.digest ?? defaultDigest;
		this.ensureDirectories();
	}

	writeOwedReceipt(identity: OncallReceiptIdentity): OncallReceiptResult {
		assertIdentity(identity);
		if (identity.book !== "contact-book") {
			throw new Error("owed_receipt_book_invalid");
		}
		const receipt = this.newReceipt(identity);
		return this.publish("owed", receipt).result;
	}

	writePendingDraft(
		input: OncallReceiptIdentity & {
			author: string;
			body: string;
			ref: string;
			to?: string;
		},
	): OncallReceiptResult {
		assertIdentity(input);
		if (!input.author.trim() || !input.body.trim() || !input.ref.trim()) {
			throw new Error("draft_content_invalid");
		}
		const receipt = this.newReceipt(input, {
			author: input.author,
			body: input.body,
			ref: input.ref,
			...(input.to ? { to: input.to } : {}),
		});
		return this.publish("pending", receipt).result;
	}

	promoteOwedToPending(input: {
		eventId: string;
		to: string;
		author: string;
		body: string;
	}): OncallReceiptResult {
		const source = this.list("owed").find(
			(receipt) => receipt.receipt.eventId === input.eventId,
		);
		if (!source) {
			const existing = this.list("pending").find(
				(receipt) =>
					receipt.receipt.book === "contact-book" &&
					receipt.receipt.eventId === input.eventId,
			);
			if (!existing) throw new Error("owed_receipt_missing");
			const expected: OncallReceipt = {
				...existing.receipt,
				author: input.author,
				to: input.to,
				body: input.body,
			};
			if (!semanticallyEqual(existing.receipt, expected)) {
				throw new Error("receipt_conflict");
			}
			return existing;
		}
		const target: OncallReceipt = {
			...source.receipt,
			author: input.author,
			to: input.to,
			body: input.body,
		};
		return this.move("pending", source, target, "owed_to_pending");
	}

	landPending(draftId: string): OncallReceiptResult {
		const source = this.readStage("pending", draftId);
		if (!source) {
			const landed = this.readStage("landed", draftId);
			if (landed) return landed;
			throw new Error("pending_receipt_missing");
		}
		const target: OncallReceipt = {
			...source.receipt,
			landedAt: new Date().toISOString(),
		};
		return this.move("landed", source, target, "pending_to_landed");
	}

	readDraftReceipt(draftId: string): OncallReceipt | undefined {
		return this.readStage("pending", draftId)?.receipt;
	}

	list(stage: OncallReceiptStage): OncallReceiptResult[] {
		this.ensureDirectories();
		return readdirSync(this.stageDirectory(stage))
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readStage(stage, name.slice(0, -3)))
			.filter((value): value is OncallReceiptResult => value !== undefined);
	}

	readBackfillDebt(): { owed: string[]; pending: number; landed: number } {
		return {
			owed: this.list("owed").map(({ receipt }) => receipt.kind),
			pending: this.list("pending").length,
			landed: this.list("landed").length,
		};
	}

	private newReceipt(
		identity: OncallReceiptIdentity,
		extra: Partial<OncallReceipt> = {},
	): OncallReceipt {
		const draftId = draftIdForIdentity(identity, this.digest);
		return {
			book: identity.book,
			lane: identity.lane,
			correlationKey: identity.correlationKey,
			eventId: identity.eventId,
			kind: identity.kind,
			draftId,
			createdAt: new Date().toISOString(),
			...extra,
		};
	}

	private move(
		to: OncallReceiptStage,
		source: OncallReceiptResult,
		target: OncallReceipt,
		operation: "owed_to_pending" | "pending_to_landed",
	): OncallReceiptResult {
		const published = this.publish(to, target);
		if (published.inserted) this.options.afterTargetLink?.(operation);
		this.safeUnlink(source.path);
		return published.result;
	}

	private publish(
		stage: OncallReceiptStage,
		receipt: OncallReceipt,
	): { inserted: boolean; result: OncallReceiptResult } {
		this.ensureDirectories();
		const path = this.receiptPath(stage, receipt.draftId);
		const tmpPath = join(
			this.stageDirectory(stage),
			`.tmp-${process.pid}-${randomUUID()}`,
		);
		writeFileSync(tmpPath, serializeOncallReceipt(receipt), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		let inserted = false;
		try {
			try {
				linkSync(tmpPath, path);
				inserted = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = this.readReceiptPath(path, receipt.draftId);
				if (!semanticallyEqual(existing, receipt)) {
					throw new Error("receipt_conflict");
				}
				receipt = existing;
			}
		} finally {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		}
		return {
			inserted,
			result: { draftId: receipt.draftId, path, receipt },
		};
	}

	private readStage(
		stage: OncallReceiptStage,
		draftId: string,
	): OncallReceiptResult | undefined {
		const path = this.receiptPath(stage, draftId);
		if (!existsSync(path)) return undefined;
		const receipt = this.readReceiptPath(path, draftId);
		return { draftId, path, receipt };
	}

	private readReceiptPath(path: string, draftId: string): OncallReceipt {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("unsafe_receipt_symlink");
		if (!stat.isFile()) throw new Error("unsafe_receipt_path");
		const receipt = parseOncallReceipt(readFileSync(path, "utf8"));
		if (receipt.draftId !== draftId) throw new Error("receipt_conflict");
		return receipt;
	}

	private safeUnlink(path: string): void {
		this.assertContained(path);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error("unsafe_receipt_symlink");
		}
		unlinkSync(path);
	}

	private receiptPath(stage: OncallReceiptStage, draftId: string): string {
		if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(draftId)) {
			throw new Error("unsafe_receipt_path");
		}
		const path = resolve(this.stageDirectory(stage), `${draftId}.md`);
		this.assertContained(path);
		return path;
	}

	private stageDirectory(stage: OncallReceiptStage): string {
		return join(this.root, stage);
	}

	private assertContained(path: string): void {
		const rel = relative(this.root, resolve(path));
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error("unsafe_receipt_path");
		}
	}

	private ensureDirectories(): void {
		if (existsSync(this.root)) {
			const rootStat = lstatSync(this.root);
			if (rootStat.isSymbolicLink()) throw new Error("unsafe_receipt_symlink");
			if (!rootStat.isDirectory()) throw new Error("unsafe_receipt_path");
		} else {
			mkdirSync(this.root, { recursive: true, mode: 0o700 });
		}
		for (const stage of ["owed", "pending", "landed"] as const) {
			const directory = this.stageDirectory(stage);
			if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
			const stat = lstatSync(directory);
			if (stat.isSymbolicLink()) throw new Error("unsafe_receipt_symlink");
			if (!stat.isDirectory()) throw new Error("unsafe_receipt_path");
		}
	}
}
