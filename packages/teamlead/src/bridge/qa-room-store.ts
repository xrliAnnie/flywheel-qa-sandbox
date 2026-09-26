import type Database from "better-sqlite3";

export const QA_ROOM_STATUSES = [
	"queued",
	"refused",
	"preparing",
	"released",
	"deploying",
	"ready",
	"failed",
	"interrupted",
	"tearing_down",
	"torn_down",
	"teardown_failed",
] as const;
export type QaRoomStatus = (typeof QA_ROOM_STATUSES)[number];
export const QA_ROOM_TERMINAL = new Set<QaRoomStatus>([
	"refused",
	"released",
	"torn_down",
]);
export interface QaRoom {
	room_id: string;
	status: QaRoomStatus;
	status_reason: string | null;
	owner_actor_key: string;
	owner_issue: string | null;
	head: string;
	slot: number;
	claim_token: string;
	physically_claimed: number;
	release_state: "held" | "releasing" | "released";
	src_dir: string;
	deploy_json: string | null;
	evidence_dir: string | null;
	request_json: string;
	created_at: string;
	updated_at: string;
}
export interface QaRoomOperation {
	operation_id: string;
	room_id: string;
	kind: "deploy" | "teardown" | "drill";
	actor_key: string;
	request_id: string;
	request_digest: string;
	attempt: number;
	status:
		| "queued"
		| "spawning"
		| "running"
		| "succeeded"
		| "failed"
		| "refused";
	operation_dir: string;
	pid: number | null;
	residue_check: string | null;
	result_json?: string | null;
	deadline_at?: string | null;
	phase_bound?: number | null;
	request_json: string;
	queued_at: string;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}
export interface QaRoomAudit {
	at: string;
	actor_key: string;
	actor_issue: string | null;
	action: "deploy" | "teardown" | "drill";
	room_id: string | null;
	slot: number | null;
	decision: "accepted" | "refused" | "completed" | "failed";
	reason: string | null;
	head: string | null;
	request_digest: string;
}
type RoomPatch = Partial<
	Pick<
		QaRoom,
		| "status"
		| "status_reason"
		| "physically_claimed"
		| "release_state"
		| "deploy_json"
		| "evidence_dir"
		| "updated_at"
	>
>;
type OperationPatch = Partial<
	Pick<
		QaRoomOperation,
		| "status"
		| "pid"
		| "residue_check"
		| "result_json"
		| "deadline_at"
		| "phase_bound"
		| "started_at"
		| "finished_at"
	>
>;

/** Room lifecycle journals share StateStore's connection and transaction boundary. */
export class QaRoomStore {
	constructor(private readonly db: Database.Database) {}

	migrate(): void {
		this.db.transaction(() =>
			this.db.exec(`
			CREATE TABLE IF NOT EXISTS qa_room (
				room_id TEXT PRIMARY KEY NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('queued','refused','preparing','released','deploying','ready','failed','interrupted','tearing_down','torn_down','teardown_failed')),
				status_reason TEXT,
				owner_actor_key TEXT NOT NULL CHECK(length(owner_actor_key) > 0),
				owner_issue TEXT,
				head TEXT NOT NULL,
				slot INTEGER NOT NULL CHECK(slot > 0),
				claim_token TEXT NOT NULL CHECK(length(claim_token) > 0),
				physically_claimed INTEGER NOT NULL DEFAULT 0 CHECK(physically_claimed IN (0,1)),
				release_state TEXT NOT NULL DEFAULT 'held' CHECK(release_state IN ('held','releasing','released')),
				src_dir TEXT NOT NULL,
				deploy_json TEXT,
				evidence_dir TEXT,
				request_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS qa_room_runner_active
				ON qa_room(owner_actor_key) WHERE owner_actor_key LIKE 'runner:%'
				AND status NOT IN ('refused','released','torn_down');
			CREATE TABLE IF NOT EXISTS qa_room_slot (
				slot INTEGER PRIMARY KEY CHECK(slot > 0),
				room_id TEXT NOT NULL REFERENCES qa_room(room_id)
			);
			CREATE TABLE IF NOT EXISTS qa_room_operation (
				operation_id TEXT PRIMARY KEY NOT NULL,
				room_id TEXT NOT NULL REFERENCES qa_room(room_id),
				kind TEXT NOT NULL CHECK(kind IN ('deploy','teardown','drill')),
				actor_key TEXT NOT NULL CHECK(length(actor_key) > 0),
				request_id TEXT NOT NULL CHECK(length(request_id) > 0),
				request_digest TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK(attempt > 0),
				status TEXT NOT NULL CHECK(status IN ('queued','spawning','running','succeeded','failed','refused')),
				operation_dir TEXT NOT NULL,
				pid INTEGER,
				residue_check TEXT,
				result_json TEXT,
				deadline_at TEXT,
				phase_bound INTEGER,
				request_json TEXT NOT NULL,
				queued_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT,
				UNIQUE(actor_key,request_id),
				UNIQUE(room_id,kind,attempt)
			);
			CREATE INDEX IF NOT EXISTS qa_room_operation_state ON qa_room_operation(status,queued_at);
			CREATE TABLE IF NOT EXISTS qa_room_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL,
				actor_key TEXT NOT NULL CHECK(length(actor_key) > 0),
				actor_issue TEXT,
				action TEXT NOT NULL CHECK(action IN ('deploy','teardown','drill')),
				room_id TEXT,
				slot INTEGER,
				decision TEXT NOT NULL CHECK(decision IN ('accepted','refused','completed','failed')),
				reason TEXT,
				head TEXT,
				request_digest TEXT NOT NULL
			);
			CREATE TRIGGER IF NOT EXISTS qa_room_audit_no_update BEFORE UPDATE ON qa_room_audit
				BEGIN SELECT RAISE(ABORT, 'qa_room_audit is append-only'); END;
			CREATE TRIGGER IF NOT EXISTS qa_room_audit_no_delete BEFORE DELETE ON qa_room_audit
				BEGIN SELECT RAISE(ABORT, 'qa_room_audit is append-only'); END;
		`),
		)();
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn).immediate();
	}

	accept(
		room: QaRoom,
		operation: QaRoomOperation,
		slots: number[],
		audit: QaRoomAudit,
	): void {
		this.transaction(() => {
			this.db
				.prepare(`INSERT INTO qa_room
				(room_id,status,status_reason,owner_actor_key,owner_issue,head,slot,claim_token,
				 physically_claimed,release_state,src_dir,deploy_json,evidence_dir,request_json,created_at,updated_at)
				VALUES (@room_id,@status,@status_reason,@owner_actor_key,@owner_issue,@head,@slot,@claim_token,
				 @physically_claimed,@release_state,@src_dir,@deploy_json,@evidence_dir,@request_json,@created_at,@updated_at)`)
				.run(room);
			for (const slot of slots)
				this.db
					.prepare("INSERT INTO qa_room_slot(slot,room_id) VALUES (?,?)")
					.run(slot, room.room_id);
			this.addOperation(operation);
			this.audit(audit);
		});
	}

	addOperation(operation: QaRoomOperation): void {
		this.db
			.prepare(`INSERT INTO qa_room_operation
			(operation_id,room_id,kind,actor_key,request_id,request_digest,attempt,status,operation_dir,
			 pid,residue_check,result_json,deadline_at,phase_bound,request_json,queued_at,created_at,started_at,finished_at)
			VALUES (@operation_id,@room_id,@kind,@actor_key,@request_id,@request_digest,@attempt,@status,@operation_dir,
			 @pid,@residue_check,@result_json,@deadline_at,@phase_bound,@request_json,@queued_at,@created_at,@started_at,@finished_at)`)
			.run({
				result_json: null,
				deadline_at: null,
				phase_bound: null,
				...operation,
			});
	}

	getRoom(id: string): QaRoom | undefined {
		return this.db.prepare("SELECT * FROM qa_room WHERE room_id=?").get(id) as
			| QaRoom
			| undefined;
	}
	rooms(): QaRoom[] {
		return this.db
			.prepare("SELECT * FROM qa_room ORDER BY created_at,room_id")
			.all() as QaRoom[];
	}
	getOperation(id: string): QaRoomOperation | undefined {
		return this.db
			.prepare("SELECT * FROM qa_room_operation WHERE operation_id=?")
			.get(id) as QaRoomOperation | undefined;
	}
	findRequest(actor: string, request: string): QaRoomOperation | undefined {
		return this.db
			.prepare(
				"SELECT * FROM qa_room_operation WHERE actor_key=? AND request_id=?",
			)
			.get(actor, request) as QaRoomOperation | undefined;
	}
	operations(roomId?: string): QaRoomOperation[] {
		return (
			roomId
				? this.db
						.prepare(
							"SELECT * FROM qa_room_operation WHERE room_id=? ORDER BY created_at,rowid",
						)
						.all(roomId)
				: this.db
						.prepare("SELECT * FROM qa_room_operation ORDER BY queued_at,rowid")
						.all()
		) as QaRoomOperation[];
	}
	reservedSlots(roomId?: string): number[] {
		const rows = (
			roomId
				? this.db
						.prepare(
							"SELECT slot FROM qa_room_slot WHERE room_id=? ORDER BY slot",
						)
						.all(roomId)
				: this.db.prepare("SELECT slot FROM qa_room_slot ORDER BY slot").all()
		) as { slot: number }[];
		return rows.map((row) => row.slot);
	}
	releaseReservations(roomId: string): void {
		this.db.prepare("DELETE FROM qa_room_slot WHERE room_id=?").run(roomId);
	}
	updateRoom(id: string, patch: RoomPatch): void {
		// Column names are fixed here, never taken from a request.
		const keys = (
			[
				"status",
				"status_reason",
				"physically_claimed",
				"release_state",
				"deploy_json",
				"evidence_dir",
				"updated_at",
			] as const
		).filter((key) => patch[key] !== undefined);
		if (keys.length)
			this.db
				.prepare(
					`UPDATE qa_room SET ${keys.map((key) => `${key}=?`).join(",")} WHERE room_id=?`,
				)
				.run(...keys.map((key) => patch[key]), id);
	}
	updateOperation(id: string, patch: OperationPatch): void {
		const keys = (
			[
				"status",
				"pid",
				"residue_check",
				"result_json",
				"deadline_at",
				"phase_bound",
				"started_at",
				"finished_at",
			] as const
		).filter((key) => patch[key] !== undefined);
		if (keys.length)
			this.db
				.prepare(
					`UPDATE qa_room_operation SET ${keys.map((key) => `${key}=?`).join(",")} WHERE operation_id=?`,
				)
				.run(...keys.map((key) => patch[key]), id);
	}
	audit(audit: QaRoomAudit): void {
		this.db
			.prepare(`INSERT INTO qa_room_audit (at,actor_key,actor_issue,action,room_id,slot,decision,reason,head,request_digest)
			VALUES (@at,@actor_key,@actor_issue,@action,@room_id,@slot,@decision,@reason,@head,@request_digest)`)
			.run(audit);
	}
	audits(): (QaRoomAudit & { id: number })[] {
		return this.db
			.prepare("SELECT * FROM qa_room_audit ORDER BY id")
			.all() as (QaRoomAudit & { id: number })[];
	}
}
