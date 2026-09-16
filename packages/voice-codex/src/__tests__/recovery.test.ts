import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceLease } from "../bridge-client.js";
import { SessionJournal } from "../journal.js";
import { recoverPinnedVoiceSession } from "../recovery.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const projection = {
	sessionId,
	mode: "meeting" as const,
	projectName: "raya",
	leadId: "raya",
	displayName: "Raya",
	realtimeVoice: "marin",
	guildId: "123456789012345678",
	voiceChannelId: "223456789012345678",
	voiceBotUserId: "323456789012345678",
	threadId: "423456789012345678",
	founderUserId: "523456789012345678",
	boundChannelIds: ["423456789012345678"],
	qaAllowUserIds: [],
};
const projects = [
	{
		projectName: "raya",
		voiceRoom: {
			guildId: projection.guildId,
			voiceChannelId: projection.voiceChannelId,
		},
		leads: [
			{
				agentId: "raya",
				botUserId: projection.voiceBotUserId,
				botTokenEnv: "RAYA_TOKEN",
			},
		],
	},
];
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "voice-recovery-"));
	roots.push(root);
	const journal = new SessionJournal(join(root, "journal.jsonl"));
	journal.append({ kind: "captured", transcriptId: "one", safeText: "hello" });
	journal.append({
		kind: "captured",
		transcriptId: "two",
		safeText: "hello again",
	});
	journal.append({
		kind: "mirrored",
		transcriptId: "two",
		messageId: "mirrored-id",
	});
	const authority = new VoiceLease(() => 0);
	authority.install(0, 15_000, 2_000);
	const replay = vi.fn(async () => 0);
	const fetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ id: projection.voiceBotUserId, bot: true }),
			),
	);
	return {
		saved: { sessionId, leaseToken: "lease", projection },
		projects,
		env: { RAYA_TOKEN: "token" },
		authority,
		journal,
		replay,
		fetchImpl,
	};
}
describe("pinned recovery", () => {
	it("checks identity before replaying either captured or mirrored work", async () => {
		const input = fixture();
		expect(await recoverPinnedVoiceSession(input)).toBe(0);
		expect(input.replay).toHaveBeenCalledAfter(input.fetchImpl);
		expect(input.replay).toHaveBeenCalledWith(
			input.saved,
			"token",
			input.authority,
		);
	});
	it.each([
		"no-lease",
		"expired",
		"legacy",
		"bad-projection",
		"wrong-session",
		"drift",
		"wrong-token",
		"http",
		"replay-error",
	])("abandons locally with zero unsafe replay on %s", async (failure) => {
		const input = fixture();
		const saved = { ...input.saved, projection: { ...projection } as unknown };
		let authority: VoiceLease | undefined = input.authority;
		if (failure === "no-lease") authority = undefined;
		if (failure === "expired") authority.fence();
		if (failure === "legacy")
			saved.projection = { ...projection, voiceBotUserId: undefined };
		if (failure === "bad-projection") saved.projection = null;
		if (failure === "wrong-session")
			saved.projection = {
				...projection,
				sessionId: "22222222-2222-4222-8222-222222222222",
			};
		if (failure === "drift")
			input.projects = [
				{
					...projects[0],
					leads: [{ ...projects[0].leads[0], botUserId: "623456789012345678" }],
				},
			];
		if (failure === "wrong-token")
			input.fetchImpl.mockImplementation(
				async () =>
					new Response(JSON.stringify({ id: "623456789012345678", bot: true })),
			);
		if (failure === "http")
			input.fetchImpl.mockImplementation(
				async () => new Response("secret", { status: 401 }),
			);
		if (failure === "replay-error")
			input.replay.mockRejectedValue(new Error("secret"));
		expect(
			await recoverPinnedVoiceSession({ ...input, saved, authority }),
		).toBe(2);
		if (failure !== "replay-error") expect(input.replay).not.toHaveBeenCalled();
		if (
			[
				"no-lease",
				"expired",
				"legacy",
				"bad-projection",
				"wrong-session",
				"drift",
			].includes(failure)
		)
			expect(input.fetchImpl).not.toHaveBeenCalled();
		expect(input.journal.pending()).toEqual([]);
		expect(
			input.journal.records().filter((row) => row.kind === "abandoned"),
		).toHaveLength(2);
		expect(JSON.stringify(input.journal.records())).not.toContain("secret");
	});
});
