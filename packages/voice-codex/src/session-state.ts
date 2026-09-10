import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { VoiceSessionProjection } from "./bridge-client.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SavedVoiceSession {
	sessionId: string;
	leaseToken: string;
	projection: VoiceSessionProjection;
}

export class SessionStateStore {
	constructor(private readonly root: string) {}

	path(sessionId: string): string {
		this.assertSessionId(sessionId);
		return join(this.root, "sessions", sessionId, "session.json");
	}

	save(session: SavedVoiceSession): void {
		this.writePrivateJson(this.path(session.sessionId), session);
	}

	saveBoot(bootId: string): void {
		if (!UUID.test(bootId)) throw new Error("voice_boot_id_invalid");
		this.writePrivateJson(join(this.root, "daemon.json"), { bootId });
	}

	private writePrivateJson(path: string, value: unknown): void {
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = join(directory, `.voice-${randomUUID()}.tmp`);
		const fd = openSync(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		try {
			writeSync(fd, `${JSON.stringify(value)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	}

	list(): SavedVoiceSession[] {
		let ids: string[];
		try {
			ids = readdirSync(join(this.root, "sessions"));
		} catch {
			return [];
		}
		return ids.flatMap((sessionId) => {
			if (!UUID.test(sessionId)) return [];
			try {
				const value = JSON.parse(
					readFileSync(this.path(sessionId), "utf8"),
				) as SavedVoiceSession;
				return value.sessionId === sessionId &&
					typeof value.leaseToken === "string" &&
					value.projection &&
					typeof value.projection === "object"
					? [value]
					: [];
			} catch {
				return [];
			}
		});
	}

	remove(sessionId: string): void {
		try {
			unlinkSync(this.path(sessionId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private assertSessionId(sessionId: string): void {
		if (!UUID.test(sessionId)) throw new Error("voice_session_id_invalid");
	}
}
