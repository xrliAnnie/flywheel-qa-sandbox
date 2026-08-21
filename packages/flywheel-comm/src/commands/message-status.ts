import { parseArgs } from "node:util";
import { CommDB } from "../db.js";
import type { MailboxSettlement, MailboxState } from "../mailbox-queue.js";
import { resolveDbPath } from "../resolve-db-path.js";

export interface MessageStatusView {
	location: "live" | "archived" | "absent";
	message_id: string;
	state: MailboxState | null;
	dead_reason: string | null;
	last_error: string | null;
	stamps: {
		created_at: string | null;
		delivered_at: string | null;
		notified_at: string | null;
		settled_at: string | null;
	};
}

export interface MessageStatusIo {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const defaultIo: MessageStatusIo = {
	stdout: console.log,
	stderr: console.error,
};

function toView(
	messageId: string,
	result: MailboxSettlement,
): MessageStatusView {
	if (result.kind === "absent_identity") {
		return {
			location: "absent",
			message_id: messageId,
			state: null,
			dead_reason: null,
			last_error: null,
			stamps: {
				created_at: null,
				delivered_at: null,
				notified_at: null,
				settled_at: null,
			},
		};
	}
	return {
		location: result.kind === "live" ? "live" : "archived",
		message_id: messageId,
		state: result.state,
		dead_reason: result.deadReason,
		last_error: result.lastError,
		stamps: {
			created_at: result.createdAt,
			delivered_at: result.deliveredAt,
			notified_at: result.notifiedAt,
			settled_at: result.settledAt,
		},
	};
}

function renderHuman(view: MessageStatusView): string {
	if (view.location === "absent") return `absent ${view.message_id}`;
	return `${view.location} ${view.state} ${view.message_id} | dead_reason=${view.dead_reason ?? "null"} | last_error=${view.last_error ?? "null"} | created_at=${view.stamps.created_at ?? "null"} | delivered_at=${view.stamps.delivered_at ?? "null"} | notified_at=${view.stamps.notified_at ?? "null"} | settled_at=${view.stamps.settled_at ?? "null"}`;
}

export function messageStatus(
	args: string[],
	io: MessageStatusIo = defaultIo,
): number {
	let values: { db?: string; project?: string; json?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				db: { type: "string" },
				project: { type: "string" },
				json: { type: "boolean", default: false },
			},
			allowPositionals: true,
		}));
	} catch (error) {
		io.stderr(`message-status: ${(error as Error).message}`);
		return 2;
	}
	const messageId = positionals[0]?.trim();
	if (!messageId || positionals.length !== 1) {
		io.stderr("message-status: exactly one <message-id> is required");
		return 2;
	}

	let db: CommDB | undefined;
	try {
		const dbPath = resolveDbPath({ db: values.db, project: values.project });
		db = CommDB.openReadonly(dbPath);
		const view = toView(messageId, db.inspectMailboxDeliveryState(messageId));
		io.stdout(values.json ? JSON.stringify(view) : renderHuman(view));
		return view.location === "absent" ? 1 : 0;
	} catch (error) {
		io.stderr(
			`message-status: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	} finally {
		db?.close();
	}
}
