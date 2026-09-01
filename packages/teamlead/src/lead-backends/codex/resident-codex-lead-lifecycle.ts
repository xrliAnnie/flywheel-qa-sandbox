import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ResidentCodexLeadPollFailureClass =
	| "auth"
	| "rate_limit"
	| "server"
	| "network"
	| "unknown";

export type ResidentCodexLeadTurnStatus =
	| "completed"
	| "failed"
	| "interrupted";

interface ResidentCodexLeadHeartbeat {
	v: 1;
	generationId: string;
	threadId: string;
	processPid: number;
	carrierInstanceId: string;
	state: "online" | "running" | "generation_lost" | "shutdown";
	onlineAt?: string;
	lastGatewayPollAttemptAt?: string;
	lastGatewayPollResultAt?: string;
	lastGatewayPollStatus?: "ok" | "failed";
	lastGatewayPollFailureClass?: ResidentCodexLeadPollFailureClass;
	lastGatewayPollStatusCode?: number;
	lastConsumedMessage?: {
		channelId: string;
		messageId: string;
		cursorPersisted: boolean;
		at: string;
	};
	activeTurn: { turnId: string; startedAt: string } | null;
	lastTurn?: {
		turnId: string;
		status: ResidentCodexLeadTurnStatus;
		at: string;
	};
	lastLifecycleEvent?: string;
	updatedAt: string;
}

export interface ResidentCodexLeadLifecycleObserverOptions {
	stateDir: string;
	threadId: string;
	generationId: string;
	processPid: number;
	carrierInstanceId: string;
	now?: () => string;
	log?: (message: string) => void;
}

function assertSafeFile(path: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`unsafe lifecycle file: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export class ResidentCodexLeadLifecycleObserver {
	private readonly root: string;
	private readonly lifecyclePath: string;
	private readonly heartbeatPath: string;
	private readonly now: () => string;
	private readonly log: (message: string) => void;
	private sequence = 0;
	private readonly heartbeat: ResidentCodexLeadHeartbeat;

	constructor(options: ResidentCodexLeadLifecycleObserverOptions) {
		if (!options.stateDir || !options.threadId || !options.generationId)
			throw new Error(
				"ResidentCodexLeadLifecycleObserver requires stable identity",
			);
		if (!Number.isInteger(options.processPid) || options.processPid < 1)
			throw new Error(
				"ResidentCodexLeadLifecycleObserver requires a positive pid",
			);
		this.root = join(options.stateDir, "brain");
		this.lifecyclePath = join(this.root, "lifecycle.jsonl");
		this.heartbeatPath = join(this.root, "heartbeat.json");
		this.now = options.now ?? (() => new Date().toISOString());
		this.log = options.log ?? (() => {});
		const createdAt = this.now();
		this.heartbeat = {
			v: 1,
			generationId: options.generationId.slice(0, 256),
			threadId: options.threadId.slice(0, 256),
			processPid: options.processPid,
			carrierInstanceId: options.carrierInstanceId.slice(0, 256),
			state: "running",
			activeTurn: null,
			updatedAt: createdAt,
		};
	}

	online(): void {
		const at = this.now();
		this.heartbeat.state = "online";
		this.heartbeat.onlineAt = at;
		this.emit("online", at);
	}

	pollAttempt(channelId: string): void {
		const at = this.now();
		this.heartbeat.lastGatewayPollAttemptAt = at;
		this.emit("gateway_poll_attempt", at, {
			channelId: channelId.slice(0, 128),
		});
	}

	pollResult(
		result:
			| { ok: true; channelId: string }
			| {
					ok: false;
					channelId: string;
					failureClass: ResidentCodexLeadPollFailureClass;
					status?: number;
			  },
	): void {
		const at = this.now();
		this.heartbeat.lastGatewayPollResultAt = at;
		this.heartbeat.lastGatewayPollStatus = result.ok ? "ok" : "failed";
		if (result.ok) {
			delete this.heartbeat.lastGatewayPollFailureClass;
			delete this.heartbeat.lastGatewayPollStatusCode;
			this.emit("gateway_poll_ok", at, {
				channelId: result.channelId.slice(0, 128),
			});
			return;
		}
		this.heartbeat.lastGatewayPollFailureClass = result.failureClass;
		if (result.status !== undefined)
			this.heartbeat.lastGatewayPollStatusCode = result.status;
		else delete this.heartbeat.lastGatewayPollStatusCode;
		this.emit("gateway_poll_failed", at, {
			channelId: result.channelId.slice(0, 128),
			failureClass: result.failureClass,
			...(result.status !== undefined ? { status: result.status } : {}),
		});
	}

	messageConsumed(input: {
		channelId: string;
		messageId: string;
		cursorPersisted: boolean;
	}): void {
		const at = this.now();
		this.heartbeat.lastConsumedMessage = {
			channelId: input.channelId.slice(0, 128),
			messageId: input.messageId.slice(0, 128),
			cursorPersisted: input.cursorPersisted,
			at,
		};
		this.emit("message_consumed", at, this.heartbeat.lastConsumedMessage);
	}

	turnStarted(turnId: string): void {
		const at = this.now();
		this.heartbeat.activeTurn = { turnId: turnId.slice(0, 256), startedAt: at };
		this.emit("turn_started", at, { turnId: turnId.slice(0, 256) });
	}

	turnFinished(turnId: string, status: ResidentCodexLeadTurnStatus): void {
		const at = this.now();
		this.heartbeat.activeTurn = null;
		this.heartbeat.lastTurn = { turnId: turnId.slice(0, 256), status, at };
		this.emit(status === "completed" ? "turn_completed" : "turn_failed", at, {
			turnId: turnId.slice(0, 256),
			status,
		});
	}

	generationLost(): void {
		const at = this.now();
		this.heartbeat.state = "generation_lost";
		this.emit("generation_lost", at);
	}

	shutdown(): void {
		const at = this.now();
		this.heartbeat.state = "shutdown";
		this.emit("shutdown", at);
	}

	private emit(
		event: string,
		at: string,
		detail: Record<string, unknown> = {},
	): void {
		this.heartbeat.updatedAt = at;
		this.heartbeat.lastLifecycleEvent = event;
		try {
			mkdirSync(this.root, { recursive: true, mode: 0o700 });
			const rootStat = lstatSync(this.root);
			if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
				throw new Error("brain state root is not a regular directory");
			chmodSync(this.root, 0o700);
			assertSafeFile(this.lifecyclePath);
			assertSafeFile(this.heartbeatPath);
			const row = {
				v: 1,
				at,
				event,
				generationId: this.heartbeat.generationId,
				threadId: this.heartbeat.threadId,
				...detail,
			};
			appendFileSync(this.lifecyclePath, `${JSON.stringify(row)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			const tmp = `${this.heartbeatPath}.tmp.${process.pid}.${this.sequence++}`;
			writeFileSync(tmp, `${JSON.stringify(this.heartbeat)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			renameSync(tmp, this.heartbeatPath);
		} catch (error) {
			this.log(
				`resident Codex Lead lifecycle write failed (${event}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
