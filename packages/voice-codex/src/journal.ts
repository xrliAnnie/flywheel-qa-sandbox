import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export type JournalRecord = {
	kind:
		| "captured"
		| "mirror_requested"
		| "mirrored"
		| "ingested"
		| "abandoned"
		| "fenced";
	transcriptId: string;
	ts?: string;
	safeText?: string;
	nonce?: string;
	speakerUserId?: string;
	speakerName?: string;
	messageId?: string;
	deliveryId?: string;
	lane?: string;
	reason?: string;
};

export interface PendingTranscript {
	transcriptId: string;
	stage: "captured" | "mirror_requested" | "mirrored";
	safeText: string;
	nonce: string;
	speakerUserId: string;
	speakerName: string;
	ts: string;
	mirrorRequestedAt?: string;
	messageId?: string;
}

export class SessionJournal {
	constructor(readonly path: string) {}

	append(record: JournalRecord): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const fd = openSync(
			this.path,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
			0o600,
		);
		try {
			chmodSync(this.path, 0o600);
			writeSync(
				fd,
				`${JSON.stringify({ ...record, ts: record.ts ?? new Date().toISOString() })}\n`,
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	records(): JournalRecord[] {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch {
			return [];
		}
		return text.split("\n").flatMap((line) => {
			if (!line) return [];
			try {
				const value = JSON.parse(line) as JournalRecord;
				return typeof value.transcriptId === "string" &&
					typeof value.kind === "string"
					? [value]
					: [];
			} catch {
				return [];
			}
		});
	}

	pending(): PendingTranscript[] {
		const rows = new Map<string, PendingTranscript>();
		for (const record of this.records()) {
			if (record.kind === "captured") {
				rows.set(record.transcriptId, {
					transcriptId: record.transcriptId,
					stage: "captured",
					safeText: record.safeText ?? "",
					nonce: record.nonce ?? "",
					speakerUserId: record.speakerUserId ?? "",
					speakerName: record.speakerName ?? "",
					ts: record.ts ?? "",
				});
				continue;
			}
			const current = rows.get(record.transcriptId);
			if (!current) continue;
			if (record.kind === "mirror_requested") {
				current.stage = "mirror_requested";
				current.mirrorRequestedAt = record.ts;
			}
			if (record.kind === "mirrored") {
				current.stage = "mirrored";
				current.messageId = record.messageId;
			}
			if (
				record.kind === "ingested" ||
				record.kind === "abandoned" ||
				record.kind === "fenced"
			) {
				rows.delete(record.transcriptId);
			}
		}
		return [...rows.values()];
	}
}
