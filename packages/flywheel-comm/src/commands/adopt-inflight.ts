import { parseArgs } from "node:util";
import { openMailboxMaintenanceDatabase } from "../db.js";
import { adoptInflightForRecipientOnConnection } from "../mailbox-queue.js";
import { resolveDbPath } from "../resolve-db-path.js";

export interface AdoptInflightIo {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const defaultIo: AdoptInflightIo = {
	stdout: console.log,
	stderr: console.error,
};

export function adoptInflight(
	args: string[],
	io: AdoptInflightIo = defaultIo,
): number {
	let values: {
		db?: string;
		project?: string;
		recipient?: string;
		kind?: string;
	};
	try {
		({ values } = parseArgs({
			args,
			options: {
				db: { type: "string" },
				project: { type: "string" },
				recipient: { type: "string" },
				kind: { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		io.stderr(`adopt-inflight: ${(error as Error).message}`);
		return 2;
	}
	const recipient = values.recipient?.trim();
	if (!recipient) {
		io.stderr("adopt-inflight: --recipient <id> is required");
		return 2;
	}
	if (values.kind !== "lead" && values.kind !== "runner") {
		io.stderr("adopt-inflight: --kind must be lead or runner");
		return 2;
	}

	let opened: ReturnType<typeof openMailboxMaintenanceDatabase> | undefined;
	try {
		const dbPath = resolveDbPath({ db: values.db, project: values.project });
		opened = openMailboxMaintenanceDatabase(dbPath);
		if (opened.status === "skipped") {
			io.stderr(`adopt-inflight WARNING: ${opened.warning}`);
			return 0;
		}
		const result = adoptInflightForRecipientOnConnection(opened.db, {
			recipientKind: values.kind,
			toAgent: recipient,
			now: new Date().toISOString(),
		});
		io.stdout(`adopted: ${result.requeued}`);
		return 0;
	} catch (error) {
		io.stderr(
			`adopt-inflight WARNING: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	} finally {
		if (opened?.status === "opened") opened.db.close();
	}
}
