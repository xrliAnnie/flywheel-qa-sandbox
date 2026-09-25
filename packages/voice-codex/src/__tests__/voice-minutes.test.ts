import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlywheelCommDelivery } from "../adapters.js";
import {
	VoiceMinutesQueue,
	type VoiceMinutesSettlement,
} from "../voice-minutes.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "fly2799-minutes-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0))
		rmSync(value, { recursive: true, force: true });
});

function payload() {
	return {
		sessionId: "session-a",
		leadId: "raya",
		projectName: "flywheel",
		threadId: "100000000000000001",
		voiceBotUserId: "100000000000000002",
		founderUserId: "100000000000000003",
		displayName: "Raya",
		transcriptDigest: "a".repeat(64),
		contextDigest: "b".repeat(64),
		status: "complete" as const,
		facts: ["讨论 FLY-2799"],
		decisions: [],
		pending: ["G1 尚未关闭"],
		handoffs: [{ handoffId: "handoff-a", state: "dispatched" }],
	};
}

describe("durable voice minutes", () => {
	it("recovers a crash before I/O and delivers the stable identity once", async () => {
		const stateRoot = root();
		const delivered = new Set<string>();
		const send = vi.fn(async (_job, deliveryId: string) => {
			delivered.add(deliveryId);
			return { deliveryId };
		});
		const first = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: send,
			inspect: () => ({ kind: "absent" }),
		});
		const job = first.enqueue(payload());
		first.prepareNext();

		const restarted = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: send,
			inspect: () => ({ kind: "absent" }),
		});
		expect(await restarted.drainOne()).toMatchObject({ state: "delivered" });
		expect(send).toHaveBeenCalledOnce();
		expect(delivered).toEqual(new Set([job.deliveryId]));
		expect(await restarted.drainOne()).toBeUndefined();
	});

	it("inspects an ack-lost crash and never sends a second mailbox effect", async () => {
		const stateRoot = root();
		const delivered = new Set<string>();
		const send = vi.fn(async (_job, deliveryId: string) => {
			delivered.add(deliveryId);
			throw new Error("ack_lost");
		});
		let settlement: VoiceMinutesSettlement = { kind: "absent" };
		const first = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: send,
			inspect: () => settlement,
		});
		const job = first.enqueue(payload());
		await expect(first.drainOne()).rejects.toThrow("ack_lost");
		settlement = { kind: "live" };

		const restarted = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: send,
			inspect: () => settlement,
		});
		expect(await restarted.drainOne()).toMatchObject({
			jobId: job.jobId,
			state: "delivered",
		});
		expect(send).toHaveBeenCalledOnce();
		expect(delivered.size).toBe(1);
	});

	it("deduplicates the same transcript and preserves incomplete/handoff states", () => {
		const queue = new VoiceMinutesQueue({
			root: root(),
			deliver: vi.fn(),
			inspect: () => ({ kind: "absent" }),
		});
		const first = queue.enqueue({ ...payload(), status: "incomplete" });
		const replay = queue.enqueue({ ...payload(), status: "incomplete" });
		expect(replay).toEqual(first);
		expect(first.payload).toMatchObject({
			status: "incomplete",
			handoffs: [{ handoffId: "handoff-a", state: "dispatched" }],
		});
	});

	it("delivers its stable identity through the real flywheel-comm carrier", async () => {
		const stateRoot = root();
		const queue = new VoiceMinutesQueue({
			root: join(stateRoot, "minutes"),
			deliver: vi.fn(),
			inspect: () => ({ kind: "absent" }),
		});
		const input = payload();
		const job = queue.enqueue(input);
		const messageId = job.deliveryId.split(":").at(-1);
		expect(messageId).toBeDefined();
		const delivery = new FlywheelCommDelivery({
			cliPath: fileURLToPath(
				new URL("../../../flywheel-comm/dist/index.js", import.meta.url),
			),
			dbPath: join(stateRoot, "comm.db"),
			founderUserId: input.founderUserId,
		});

		const receipt = await delivery.ingest({
			leadId: input.leadId,
			voiceSessionId: input.sessionId,
			threadId: input.threadId,
			messageId: messageId as string,
			authorId: input.voiceBotUserId,
			authorName: `${input.displayName} voice minutes`,
			text: "voice minutes",
			ts: "2026-09-23T00:00:00.000Z",
			origin: "voice_minutes",
		});

		expect(receipt.deliveryId).toBe(job.deliveryId);
		expect(await delivery.read(job.deliveryId)).toEqual({
			origin: "voice_minutes",
			voiceSessionId: input.sessionId,
			authorId: input.voiceBotUserId,
			text: "voice minutes",
		});

		// What the Lead model actually reads is the rendered delivery body. The
		// minutes must not be framed as live founder dictation awaiting a spoken
		// reply; that banner belongs to real founder utterances only.
		const { MailboxQueue } = (await import(
			/* @vite-ignore */ fileURLToPath(
				new URL(
					"../../../flywheel-comm/dist/mailbox-queue.js",
					import.meta.url,
				),
			)
		)) as {
			MailboxQueue: new (
				path: string,
			) => {
				getById(id: string): { delivery_content: string | null } | undefined;
				close(): void;
			};
		};
		const mailbox = new MailboxQueue(join(stateRoot, "comm.db"));
		const row = mailbox.getById(job.deliveryId);
		mailbox.close();
		expect(row?.delivery_content).toContain('source="voice-minutes"');
		expect(row?.delivery_content).toContain(
			"[voice-minutes] 这是一场已结束语音会话的纪要",
		);
		expect(row?.delivery_content).not.toContain("这句话是 founder 口述");
	});

	it("normalizes the legacy non-snowflake identity during durable recovery", () => {
		const stateRoot = root();
		const queue = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: vi.fn(),
			inspect: () => ({ kind: "absent" }),
		});
		const job = queue.enqueue(payload());
		const path = join(stateRoot, `${job.jobId}.json`);
		const encoded = JSON.parse(readFileSync(path, "utf8")) as {
			deliveryId: string;
		};
		encoded.deliveryId = `chat:${job.payload.leadId}:voice-minutes-${job.jobId}`;
		writeFileSync(path, `${JSON.stringify(encoded)}\n`);

		const restarted = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: vi.fn(),
			inspect: () => ({ kind: "absent" }),
		});
		const recovered = restarted.prepareNext();

		expect(recovered?.deliveryId).toMatch(/^chat:raya:\d{19,20}$/u);
	});

	it("fails visibly instead of dropping a corrupt durable job", async () => {
		const stateRoot = root();
		const queue = new VoiceMinutesQueue({
			root: stateRoot,
			deliver: vi.fn(),
			inspect: () => ({ kind: "absent" }),
		});
		const job = queue.enqueue(payload());
		writeFileSync(join(stateRoot, `${job.jobId}.json`), "{broken\n");

		await expect(queue.drainOne()).rejects.toThrow("voice_minutes_job_corrupt");
	});
});
