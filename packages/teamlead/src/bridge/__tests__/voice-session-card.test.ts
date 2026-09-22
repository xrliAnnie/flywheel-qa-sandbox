import { describe, expect, it, vi } from "vitest";
import type { VoiceSessionRow } from "../../StateStore.js";
import {
	renderVoiceSessionCard,
	VoiceSessionCardProjector,
} from "../voice-session-card.js";

const NOW = "2026-09-17T20:00:00.000Z";

function session(overrides: Partial<VoiceSessionRow> = {}): VoiceSessionRow {
	return {
		sessionId: "10000000-0000-4000-8000-000000000001",
		mode: "rg",
		projectName: "raya",
		leadId: "raya",
		guildId: "guild",
		voiceChannelId: "voice",
		voiceBotUserId: "bot",
		provisioningStep: "done",
		provisionerEpoch: null,
		provisioningNonce: null,
		rootRequestedAt: null,
		rootMessageId: "root",
		threadId: "thread",
		memberAddedAt: null,
		cancelRequestedAt: null,
		endingStartedAt: null,
		orphanCandidates: [],
		boundChannelIds: ["thread"],
		meetingId: null,
		evidenceDir: null,
		topic: null,
		requestedBy: "master",
		credentialTier: "master",
		state: "live",
		reason: null,
		daemonBootId: "boot",
		leaseToken: "lease",
		leaseExpiresAt: "2026-09-17T20:00:15.000Z",
		receiveHealth: {
			version: 1,
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
			failures: 1,
			retries: 1,
			lastPcmAt: null,
		},
		receiveHealthObservedAt: NOW,
		receiveHealthBootId: "boot",
		receiveCardDigest: null,
		outboundCursor: {},
		createdAt: NOW,
		updatedAt: NOW,
		endedAt: null,
		...overrides,
	};
}

describe("renderVoiceSessionCard", () => {
	it("renders bounded degraded, receiving, stale, and terminal copy", () => {
		expect(renderVoiceSessionCard(session(), NOW, 4_000)).toContain(
			"收音暂不可用（加密音频未解开），文字回复仍可播报，请稍后重说",
		);
		expect(
			renderVoiceSessionCard(
				session({
					receiveHealth: {
						...session().receiveHealth!,
						state: "receiving",
						reason: "audio_observed",
					},
				}),
				NOW,
				4_000,
			),
		).toContain("已接收音频；对话是否成功以实际回复为准");
		expect(
			renderVoiceSessionCard(
				session({
					receiveHealthObservedAt: "2026-09-17T19:59:40.000Z",
				}),
				NOW,
				4_000,
			),
		).toContain("等待你说话");
		const terminal = renderVoiceSessionCard(
			session({ state: "failed", reason: "lease_lost" }),
			NOW,
			4_000,
		);
		expect(terminal).toContain("会话已结束（lease_lost）");
		expect(terminal).not.toContain("加密音频未解开");
		expect(terminal.startsWith("📻")).toBe(true);
	});
});

describe("VoiceSessionCardProjector", () => {
	it("patches only changed content and persists the successful digest", async () => {
		const row = session();
		const patch = vi.fn(async () => {});
		const mark = vi.fn((_snapshot: VoiceSessionRow, digest: string) => {
			row.receiveCardDigest = digest;
			return true;
		});
		const projector = new VoiceSessionCardProjector({
			store: {
				listVoiceSessionCardCandidates: () => [row],
				getVoiceSession: () => row,
				markVoiceSessionCardProjected: mark,
			},
			leaseRenewMs: 4_000,
			now: () => NOW,
			validateSession: vi.fn(async () => {}),
			patch,
		});

		await projector.tick();
		await projector.tick();
		expect(patch).toHaveBeenCalledTimes(1);
		expect(mark).toHaveBeenCalledTimes(1);
	});

	it("backs off a failed patch without blocking later retries", async () => {
		const row = session();
		let now = NOW;
		const patch = vi
			.fn<
				(
					row: VoiceSessionRow,
					content: string,
					signal: AbortSignal,
				) => Promise<void>
			>()
			.mockRejectedValueOnce(new Error("Discord 403"))
			.mockResolvedValue(undefined);
		const projector = new VoiceSessionCardProjector({
			store: {
				listVoiceSessionCardCandidates: () => [row],
				getVoiceSession: () => row,
				markVoiceSessionCardProjected: () => true,
			},
			leaseRenewMs: 4_000,
			now: () => now,
			validateSession: vi.fn(async () => {}),
			patch,
		});

		await projector.tick();
		await projector.tick();
		expect(patch).toHaveBeenCalledTimes(1);
		now = "2026-09-17T20:00:30.000Z";
		await projector.tick();
		expect(patch).toHaveBeenCalledTimes(2);
	});
});
