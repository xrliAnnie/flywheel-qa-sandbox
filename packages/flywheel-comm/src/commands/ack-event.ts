import { CommDB } from "../db.js";

export interface AckEventArgs {
	dbPath: string;
	eventSeq: number;
	ackToken: string;
	leadId: string;
}

export function ackEvent(args: AckEventArgs): string {
	if (!args.ackToken.trim()) throw new Error("ACK token is required");
	const db = new CommDB(args.dbPath, false);
	try {
		return db.insertAckReceipt(
			args.leadId,
			args.eventSeq,
			args.ackToken.trim(),
		);
	} finally {
		db.close();
	}
}
