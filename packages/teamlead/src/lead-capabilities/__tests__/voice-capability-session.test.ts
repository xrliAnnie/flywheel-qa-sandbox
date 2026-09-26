import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createVoiceCapabilityTurns,
	openVoiceCapabilityJournal,
	prepareVoiceCapabilityAuth,
} from "../voice-capability-session.js";

const roots: string[] = [];
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "voice-cap-session-")));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("owns only the fresh home auth link and detects replacement without reading credentials", () => {
	const root = fixture(),
		home = join(root, "home"),
		source = join(root, "subscription.json");
	mkdirSync(home, { mode: 0o700 });
	writeFileSync(source, "synthetic auth", { mode: 0o600 });
	const auth = prepareVoiceCapabilityAuth({
		codexHome: home,
		authSourcePath: source,
	});
	expect(realpathSync(join(home, "auth.json"))).toBe(source);
	auth.assertCurrent();
	expect(() =>
		prepareVoiceCapabilityAuth({ codexHome: home, authSourcePath: source }),
	).toThrow(/voice_capability_auth/);
	auth.close();
	expect(existsSync(source)).toBe(true);
	expect(existsSync(join(home, "auth.json"))).toBe(false);
	expect(existsSync(join(home, "config.toml"))).toBe(false);
});

it("binds durable turn context once, fences concurrent turns, and preserves restart evidence", () => {
	const root = fixture();
	let journal = openVoiceCapabilityJournal(root, sessionId);
	const release = vi.fn();
	const enterDeliveryContext = vi.fn((id: string) => {
		expect(journal.getById(id)?.state).toBe("dispatching");
		return release;
	});
	const turns = createVoiceCapabilityTurns({
		sessionId,
		journal,
		enterDeliveryContext,
		assertCurrent() {},
	});
	turns.beginTurn("thread-a", "turn-a");
	turns.beginTurn("thread-a", "turn-a");
	expect(enterDeliveryContext).toHaveBeenCalledOnce();
	expect(() => turns.beginTurn("thread-a", "turn-b")).toThrow(
		"voice_capability_turn_busy",
	);
	turns.endTurn("old-turn", "completed");
	expect(release).not.toHaveBeenCalled();
	turns.endTurn("turn-a", "completed");
	turns.endTurn("turn-a", "completed");
	expect(release).toHaveBeenCalledOnce();
	const id = enterDeliveryContext.mock.calls[0]![0];
	expect(journal.getById(id)?.state).toBe("model_completed");
	turns.beginTurn("thread-a", "turn-b");
	turns.close();
	journal.close();
	expect(
		existsSync(join(root, "voice-capability", sessionId, "journal.db")),
	).toBe(true);
	journal = openVoiceCapabilityJournal(root, sessionId);
	expect(journal.getById(id)?.state).toBe("model_completed");
	expect(journal.listUnfinished().some((row) => row.turnId === "turn-b")).toBe(
		false,
	);
	const resumed = createVoiceCapabilityTurns({
		sessionId,
		journal,
		enterDeliveryContext,
		assertCurrent() {},
	});
	expect(() => resumed.beginTurn("thread-a", "turn-a")).toThrow(
		"voice_capability_turn_replayed",
	);
	resumed.close();
	journal.close();
});

it("rejects escaped session paths before creating a journal", () => {
	const root = fixture();
	expect(() => openVoiceCapabilityJournal(root, "../../foreign")).toThrow(
		/voice_capability_journal/,
	);
	expect(existsSync(join(root, "voice-capability"))).toBe(false);
});

it("rejects a dangling journal symlink without creating its target", () => {
	const root = fixture(),
		dir = join(root, "voice-capability", sessionId),
		target = join(root, "foreign.db");
	mkdirSync(join(root, "voice-capability"), { mode: 0o700 });
	mkdirSync(dir, { mode: 0o700 });
	symlinkSync(target, join(dir, "journal.db"));
	let opened: ReturnType<typeof openVoiceCapabilityJournal> | undefined;
	try {
		expect(() => {
			opened = openVoiceCapabilityJournal(root, sessionId);
		}).toThrow("voice_capability_journal_invalid");
	} finally {
		opened?.close();
	}
	expect(existsSync(target)).toBe(false);
});

it("keeps thread and turn identity boundaries distinct in durable deduplication", () => {
	const root = fixture(),
		journal = openVoiceCapabilityJournal(root, sessionId);
	const turns = createVoiceCapabilityTurns({
		sessionId,
		journal,
		assertCurrent() {},
		enterDeliveryContext: () => () => {},
	});
	try {
		turns.beginTurn("thread:a", "turn");
		turns.endTurn("turn", "completed");
		expect(() => turns.beginTurn("thread", "a:turn")).not.toThrow();
	} finally {
		turns.close();
		journal.close();
	}
});
