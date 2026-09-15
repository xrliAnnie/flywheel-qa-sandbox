import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexOutboundSender } from "../CodexOutboundSender.js";

it("freezes proactive mode and retains sent/pending through reopen, then resumes until ready", async () => {
	const root = mkdtempSync(join(tmpdir(), "outbox-proactive-"));
	const messageId = "22222222222222222";
	const post = vi
		.fn()
		.mockResolvedValueOnce({
			status: 202,
			body: JSON.stringify({
				status: "pending",
				sendStatus: "sent",
				messageId,
				engagement: "pending",
			}),
		})
		.mockRejectedValueOnce(Error("offline"))
		.mockResolvedValue({
			status: 200,
			body: JSON.stringify({
				status: "sent",
				sendStatus: "sent",
				messageId,
				engagement: "ready",
				threadId: messageId,
			}),
		});
	const opts = {
		bridgeUrl: "http://bridge",
		apiToken: "test",
		projectName: "p",
		leadId: "l",
		channelId: "11111111111111111",
		dbPath: join(root, "outbox.db"),
		post,
	};
	let sender = new CodexOutboundSender(opts);
	try {
		const args = {
			leadId: "l",
			text: "question",
			idempotencyKey: "k",
			roundtableEngage: true,
		};
		await sender.enqueue(args);
		expect(await sender.deliverWithResult("k")).toMatchObject({
			sendStatus: "sent",
			engagement: "pending",
			messageId,
		});
		sender.close();
		sender = new CodexOutboundSender(opts);
		await expect(
			sender.enqueue({ ...args, roundtableEngage: false }),
		).rejects.toThrow(/conflict/);
		await expect(sender.deliverWithResult("k")).rejects.toThrow();
		expect(await sender.deliverWithResult("k")).toMatchObject({
			engagement: "ready",
			messageId,
			threadId: messageId,
		});
		await sender.deliverWithResult("k");
		expect(post).toHaveBeenCalledTimes(3);
		expect(
			post.mock.calls.map((c) => JSON.parse(c[0].body).roundtableEngage),
		).toEqual([true, true, true]);
	} finally {
		sender.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps pending engagement on its event id beyond the normal TTL and rejects a different project opening the outbox", async () => {
	const root = mkdtempSync(join(tmpdir(), "outbox-project-"));
	let now = 1;
	const post = vi.fn(async () => ({
		status: 202,
		body: JSON.stringify({
			status: "pending",
			sendStatus: "sent",
			messageId: "22222222222222222",
			engagement: "pending",
		}),
	}));
	const opts = {
		bridgeUrl: "http://bridge",
		apiToken: "test",
		projectName: "p",
		leadId: "l",
		channelId: "11111111111111111",
		dbPath: join(root, "outbox.db"),
		post,
		now: () => now,
		proactiveEventIdTtlMs: 10,
	};
	let sender = new CodexOutboundSender(opts);
	try {
		const event = sender.allocateEventId("roundtable", "question");
		const key = `lead-action:p:l:${event}`;
		await sender.enqueue({
			leadId: "l",
			text: "question",
			idempotencyKey: key,
			roundtableEngage: true,
		});
		await sender.deliverWithResult(key);
		now = 100;
		expect(sender.allocateEventId("roundtable", "question")).toBe(event);
		sender.close();
		sender = new CodexOutboundSender({ ...opts, projectName: "other" });
		await expect(sender.deliverWithResult(key)).rejects.toThrow(/project/);
		expect(post).toHaveBeenCalledOnce();
	} finally {
		sender.close();
		rmSync(root, { recursive: true, force: true });
	}
});
