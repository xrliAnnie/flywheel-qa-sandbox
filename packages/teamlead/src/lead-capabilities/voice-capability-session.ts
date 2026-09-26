import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { LeadJournal } from "../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../lead-backends/codex/SqliteJournalStore.js";

/** Only a fresh voice home may acquire the parent's subscription auth link. */
export function prepareVoiceCapabilityAuth(input: {
	codexHome: string;
	authSourcePath: string;
}) {
	const denied = () => new Error("voice_capability_auth_invalid");
	const home = lstatSync(input.codexHome);
	if (
		realpathSync(input.codexHome) !== input.codexHome ||
		!home.isDirectory() ||
		home.uid !== process.getuid?.() ||
		(home.mode & 0o777) !== 0o700
	)
		throw denied();
	const source = realpathSync(input.authSourcePath),
		before = lstatSync(source);
	if (
		!before.isFile() ||
		before.uid !== process.getuid?.() ||
		(before.mode & 0o777) !== 0o600
	)
		throw denied();
	const target = join(input.codexHome, "auth.json");
	try {
		lstatSync(target);
		throw denied();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existsSync(join(input.codexHome, "config.toml"))) throw denied();
	symlinkSync(source, target);
	const link = lstatSync(target);
	let closed = false;
	return {
		authSourcePath: source,
		assertCurrent() {
			if (closed) throw denied();
			const actual = lstatSync(source),
				current = lstatSync(target);
			if (
				!actual.isFile() ||
				actual.uid !== before.uid ||
				(actual.mode & 0o777) !== 0o600 ||
				!current.isSymbolicLink() ||
				current.ino !== link.ino ||
				current.dev !== link.dev ||
				realpathSync(target) !== source ||
				realpathSync(input.authSourcePath) !== source
			)
				throw denied();
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				const current = lstatSync(target);
				if (
					current.isSymbolicLink() &&
					current.ino === link.ino &&
					current.dev === link.dev
				)
					unlinkSync(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}

/** This durable session directory survives activation and container cleanup. */
export function openVoiceCapabilityJournal(
	stateDir: string,
	sessionId: string,
) {
	const denied = () => new Error("voice_capability_journal_invalid");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
			sessionId,
		)
	)
		throw denied();
	const state = realpathSync(stateDir);
	if (!lstatSync(state).isDirectory()) throw denied();
	let directory = state;
	for (const name of ["voice-capability", sessionId]) {
		directory = join(directory, name);
		try {
			mkdirSync(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(directory);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			realpathSync(directory) !== directory ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0
		)
			throw denied();
	}
	const path = join(directory, "journal.db");
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.()
		)
			throw denied();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return new SqliteJournalStore(path);
}

/** Observed background turns bind browser/write receipts to a durable journal entry.
 * These callbacks do not claim dispatch-before-RPC or frontend delivery proof. */
export function createVoiceCapabilityTurns(input: {
	sessionId: string;
	journal: SqliteJournalStore;
	enterDeliveryContext(entryId: string): () => void;
	assertCurrent(): void;
	/** Called after the turn's delivery context is released. */
	onTurnEnded?(entryId: string): void;
}) {
	const journal = new LeadJournal({ store: input.journal });
	let active:
		| { threadId: string; turnId: string; entryId: string; release(): void }
		| undefined;
	let closed = false;
	/** Bounded turnId → journal entry map for per-turn receipt lookups. */
	const entries = new Map<string, string>();
	const endTurn = (
		turnId: string,
		outcome: "completed" | "failed" | "interrupted",
	) => {
		if (!active || active.turnId !== turnId) return;
		const turn = active;
		active = undefined;
		try {
			if (outcome === "completed") journal.toModelCompleted(turn.entryId);
			else journal.toAmbiguous(turn.entryId, `voice_turn_${outcome}`);
		} finally {
			turn.release();
			input.onTurnEnded?.(turn.entryId);
		}
	};
	return {
		entryFor(turnId: string): string | undefined {
			return entries.get(turnId);
		},
		beginTurn(threadId: string, turnId: string) {
			if (closed) throw new Error("voice_capability_turn_closed");
			input.assertCurrent();
			if (
				![threadId, turnId].every(
					(value) =>
						typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value),
				)
			)
				throw new Error("voice_capability_turn_invalid");
			if (active?.threadId === threadId && active.turnId === turnId) return;
			if (active) throw new Error("voice_capability_turn_busy");
			const accepted = journal.accept({
				idempotencyKey: `voice:${JSON.stringify([input.sessionId, threadId, turnId])}`,
				source: "founder-terminal",
				payload: JSON.stringify({
					sessionId: input.sessionId,
					threadId,
					turnId,
				}),
			});
			if (!accepted.accepted) throw new Error("voice_capability_turn_replayed");
			journal.toDispatching(accepted.entry.id, `${threadId}:${turnId}`);
			const release = input.enterDeliveryContext(accepted.entry.id);
			try {
				journal.toDispatched(accepted.entry.id, turnId);
				active = { threadId, turnId, entryId: accepted.entry.id, release };
				entries.set(turnId, accepted.entry.id);
				if (entries.size > 256)
					entries.delete(entries.keys().next().value as string);
			} catch (error) {
				release();
				throw error;
			}
		},
		endTurn,
		close() {
			if (closed) return;
			closed = true;
			if (active) endTurn(active.turnId, "interrupted");
		},
	};
}
