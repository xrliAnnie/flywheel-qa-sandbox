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

import { SessionJournal } from "./journal.js";
import {
	parseVoiceProjection,
	VOICE_SESSION_UUID as UUID,
} from "./projection.js";
import { abandonVoiceJournal } from "./recovery.js";

export interface VoiceRecoveryRecord {
	sessionId: string;
	leaseToken: string;
	projection: unknown;
}

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
		parseVoiceProjection(session.projection, session.sessionId);
		if (!session.leaseToken) throw new Error("voice_lease_token_invalid");
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

	list(): VoiceRecoveryRecord[] {
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
				) as VoiceRecoveryRecord | null;
				if (
					!value ||
					value.sessionId !== sessionId ||
					typeof value.leaseToken !== "string" ||
					!value.leaseToken
				)
					throw new Error("voice_saved_authority_invalid");
				// The old lease can be checked, but projection remains untrusted until recovery admission.
				return [value];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				abandonVoiceJournal(
					new SessionJournal(
						join(this.root, "sessions", sessionId, "journal.jsonl"),
					),
					"voice_saved_authority_invalid",
				);
				this.quarantine(sessionId);
				return [];
			}
		});
	}

	quarantine(sessionId: string): void {
		const path = this.path(sessionId);
		try {
			renameSync(
				path,
				join(dirname(path), `session.quarantined-${randomUUID()}.json`),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
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
