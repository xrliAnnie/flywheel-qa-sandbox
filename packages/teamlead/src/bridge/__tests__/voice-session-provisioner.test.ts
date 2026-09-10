import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { msToSnowflakeLowerBound } from "../founder-notify-utils.js";
import {
	createDiscordVoiceProvisionerDeps,
	runVoiceProvisioner,
} from "../voice-session-provisioner.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-08T20:00:00.000Z";
const cleanup: string[] = [];
let store: StateStore;

beforeEach(async () => {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-provisioner-"));
	cleanup.push(root);
	store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		meetingId: "20000000-0000-4000-8000-000000000001",
		evidenceDir: "/evidence/a",
		topic: "Voice meeting",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
});

afterEach(() => {
	store.close();
	for (const root of cleanup.splice(0)) rmSync(root, { recursive: true });
});

function deps() {
	return {
		captureCursor: vi.fn(async () => "100000000000000010"),
		postRoot: vi.fn(async () => "100000000000000011"),
		startThread: vi.fn(async () => "100000000000000011"),
		addMember: vi.fn(async () => true),
		postCancelled: vi.fn(async () => {}),
		archiveThread: vi.fn(async () => {}),
	};
}

function run(
	overrides: Partial<Parameters<typeof runVoiceProvisioner>[0]> = {},
) {
	return runVoiceProvisioner({
		store,
		sessionId: SESSION_ID,
		epoch: "epoch-a",
		now: () => T0,
		staleMs: 120_000,
		context: {
			chatChannelId: "100000000000000004",
			leadBotToken: "lead-token",
			founderUserId: "100000000000000005",
		},
		deps: deps(),
		...overrides,
	});
}

describe("voice session provisioner", () => {
	it("seeds an empty channel at the current snowflake instead of failing or backfilling", async () => {
		const now = Date.now();
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const cursor = await createDiscordVoiceProvisionerDeps(
			fetchImpl as typeof fetch,
		).captureCursor({ channelId: "100000000000000004", botToken: "token" });
		expect(BigInt(cursor)).toBeGreaterThanOrEqual(
			BigInt(msToSnowflakeLowerBound(now)),
		);
		expect(BigInt(cursor)).toBeLessThanOrEqual(
			BigInt(msToSnowflakeLowerBound(Date.now() + 1)),
		);
	});

	it("runs the single resumable reducer from reservation through desired", async () => {
		const effects = deps();
		await expect(run({ deps: effects })).resolves.toBe("desired");
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "desired",
			provisioningStep: "done",
			provisionerEpoch: "epoch-a",
			rootMessageId: "100000000000000011",
			threadId: "100000000000000011",
			memberAddedAt: T0,
			boundChannelIds: ["100000000000000004", "100000000000000011"],
			outboundCursor: {
				"100000000000000004": "100000000000000010",
				"100000000000000011": "100000000000000011",
			},
		});
		expect(effects.postRoot).toHaveBeenCalledWith(
			expect.objectContaining({
				nonce: expect.stringMatching(/^[0-9a-z]{1,25}$/),
			}),
		);
		expect(effects.startThread).toHaveBeenCalledWith(
			expect.objectContaining({
				threadName: "🎙️ Voice meeting · 2026-09-08",
			}),
		);
	});

	it("replays a root request with the same nonce after a receipt-window crash", async () => {
		const effects = deps();
		let crashed = false;
		await expect(
			run({
				deps: effects,
				afterEffect: (step) => {
					if (step === "root_requested" && !crashed) {
						crashed = true;
						throw new Error("crash_after_root");
					}
				},
			}),
		).rejects.toThrow("crash_after_root");
		const nonce = store.getVoiceSession(SESSION_ID)!.provisioningNonce;
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			provisioningStep: "root_requested",
			rootMessageId: null,
		});
		await expect(run({ deps: effects })).resolves.toBe("desired");
		expect(effects.postRoot.mock.calls.map(([value]) => value.nonce)).toEqual([
			nonce,
			nonce,
		]);
	});

	it("lets only one fresh provisioner epoch own a row", async () => {
		expect(store.claimVoiceProvisioner(SESSION_ID, "epoch-a", T0, T0)).toBe(
			true,
		);
		expect(store.claimVoiceProvisioner(SESSION_ID, "epoch-b", T0, T0)).toBe(
			false,
		);
		await expect(run({ epoch: "epoch-b" })).resolves.toBe("not_owner");
	});

	it("has the provisioner consume cancellation and clean persisted effects", async () => {
		store.claimVoiceProvisioner(SESSION_ID, "epoch-a", T0, T0);
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "thread_requested",
			updatedAt: T0,
			provisionerEpoch: "epoch-a",
			rootMessageId: "100000000000000011",
			threadId: "100000000000000011",
		});
		store.stopVoiceSession(SESSION_ID, T0);
		const effects = deps();
		await expect(run({ deps: effects })).resolves.toBe("cancelled");
		expect(effects.postCancelled).toHaveBeenCalledWith({
			threadOrChannelId: "100000000000000011",
			botToken: "lead-token",
		});
		expect(effects.archiveThread).toHaveBeenCalledWith({
			threadId: "100000000000000011",
			botToken: "lead-token",
		});
		expect(store.getVoiceSession(SESSION_ID)?.state).toBe("cancelled");
	});
});

it("retries an unknown root inside its nonce window with the identical nonce", async () => {
	const effects = deps();
	effects.postRoot.mockRejectedValueOnce(
		new Error("timeout_after_discord_accept"),
	);
	await expect(run({ deps: effects })).resolves.toBe("desired");
	expect(effects.postRoot).toHaveBeenCalledTimes(2);
	expect(effects.postRoot.mock.calls[0]).toEqual(
		effects.postRoot.mock.calls[1],
	);
});

it("never reposts an uncertain root after its frozen nonce window across takeover", async () => {
	const effects = deps();
	await expect(
		run({
			deps: effects,
			afterEffect: (step) => {
				if (step === "root_requested") throw new Error("crash_before_receipt");
			},
		}),
	).rejects.toThrow("crash_before_receipt");
	const originalNonce = store.getVoiceSession(SESSION_ID)!.provisioningNonce;
	await expect(
		run({
			deps: effects,
			epoch: "epoch-b",
			now: () => "2026-09-08T20:03:00.000Z",
		}),
	).resolves.toBe("failed");
	expect(effects.postRoot).toHaveBeenCalledOnce();
	expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
		reason: "provisioning_root_unknown",
		orphanCandidates: [`nonce:${originalNonce}`],
	});
});

it.each(["root", "thread"])(
	"preserves the successful %s receipt when stop races the external call",
	async (stage) => {
		const effects = deps();
		if (stage === "root")
			effects.postRoot.mockImplementation(async () => {
				store.stopVoiceSession(SESSION_ID, T0);
				return "100000000000000011";
			});
		else
			effects.startThread.mockImplementation(async () => {
				store.stopVoiceSession(SESSION_ID, T0);
				return "100000000000000012";
			});
		await expect(run({ deps: effects })).resolves.toBe("cancelled");
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "cancelled",
			rootMessageId: "100000000000000011",
			...(stage === "thread" ? { threadId: "100000000000000012" } : {}),
		});
		if (stage === "root") {
			expect(effects.startThread).not.toHaveBeenCalled();
			expect(effects.postCancelled).toHaveBeenCalledWith({
				threadOrChannelId: "100000000000000004",
				replyTo: "100000000000000011",
				botToken: "lead-token",
			});
		} else {
			expect(effects.addMember).not.toHaveBeenCalled();
			expect(effects.archiveThread).toHaveBeenCalledWith({
				threadId: "100000000000000012",
				botToken: "lead-token",
			});
		}
	},
);

it("records cancellation cleanup failures instead of silently claiming clean cancellation", async () => {
	const effects = deps();
	effects.startThread.mockImplementation(async () => {
		store.stopVoiceSession(SESSION_ID, T0);
		return "100000000000000012";
	});
	effects.archiveThread.mockRejectedValue(new Error("403"));
	await expect(run({ deps: effects })).resolves.toBe("cancelled");
	expect(store.getVoiceSession(SESSION_ID)?.reason).toContain("archive_failed");
});

it.each(["root", "thread"])(
	"consumes cancellation after a failed %s response without claiming failure",
	async (stage) => {
		const effects = deps();
		const cancel = async () => {
			store.stopVoiceSession(SESSION_ID, T0);
			throw new Error("response_lost");
		};
		if (stage === "root") effects.postRoot.mockImplementation(cancel);
		else effects.startThread.mockImplementation(cancel);
		await expect(run({ deps: effects })).resolves.toBe("cancelled");
		if (stage === "root")
			expect(store.getVoiceSession(SESSION_ID)?.orphanCandidates).toEqual([
				`nonce:${store.getVoiceSession(SESSION_ID)?.provisioningNonce}`,
			]);
		expect(effects.addMember).not.toHaveBeenCalled();
	},
);
