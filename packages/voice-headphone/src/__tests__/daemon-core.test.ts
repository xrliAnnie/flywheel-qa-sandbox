import { HeadphoneQueue } from "flywheel-voice-core";
import { describe, expect, it } from "vitest";
import type {
	GateBinding,
	VoiceContext,
	VoiceScope,
} from "../bridge-client.js";
import { type GatewayMessage, HeadphoneDaemonCore } from "../daemon-core.js";

const SCOPE: VoiceScope = {
	leadBotIds: ["lead-tadashi", "lead-hl"],
	systemBotIds: ["bridge-bot"],
	scopeChannelIds: ["chat-1", "thread-906", "core-1"],
	roundtableChannelIds: ["rt-1"],
	founderIdFingerprint: "annie-id",
};

class FakeBridge {
	contexts = new Map<string, VoiceContext>();
	bindings = new Map<string, GateBinding>();
	async getContext(channelId: string): Promise<VoiceContext> {
		return this.contexts.get(channelId) ?? { kind: "unknown" };
	}
	async getGateBinding(messageId: string): Promise<GateBinding> {
		return this.bindings.get(messageId) ?? { bound: false };
	}
}

class FakeMachine {
	events: unknown[] = [];
	state = "off";
	handleEvent(ev: { type: string }): void {
		this.events.push(ev);
		if (ev.type === "start") this.state = "idle";
	}
}

const msg = (over: Partial<GatewayMessage> = {}): GatewayMessage => ({
	id: "500",
	channelId: "thread-906",
	channelName: "FLY-906-thread",
	authorId: "lead-tadashi",
	authorIsBot: true,
	content: "PRD 写完了",
	mentionsFounder: false,
	...over,
});

function build(over: { modeOn?: boolean; includeRoundtable?: boolean } = {}) {
	const bridge = new FakeBridge();
	const queue = new HeadphoneQueue();
	const machine = new FakeMachine();
	const saved: unknown[] = [];
	const core = new HeadphoneDaemonCore({
		scope: SCOPE,
		bridge,
		queue,
		machine,
		selfBotId: "hp-bot",
		founderUserId: "annie-id",
		coreChannelId: "core-1",
		includeRoundtable: over.includeRoundtable ?? false,
		modeOn: over.modeOn ?? true,
		persist: () => saved.push(1),
	});
	return { bridge, queue, machine, core, saved };
}

describe("HeadphoneDaemonCore — gateway tap → enqueue", () => {
	it("enqueues a lead-bot message with issue-thread context headline", async () => {
		const { bridge, queue, machine, core } = build();
		bridge.contexts.set("thread-906", {
			kind: "issue_thread",
			issueId: "uuid-906",
			issueIdentifier: "FLY-906",
			issueTitle: "语音产品设计",
			agentId: "tadashi",
			stage: "implement",
		});
		await core.onGatewayMessage(msg());
		expect(queue.size()).toBe(1);
		const item = queue.peek();
		expect(item).toMatchObject({
			messageId: "500",
			agentId: "tadashi",
			kind: "normal",
			headline: {
				agentDisplay: "tadashi",
				issueRef: "FLY-906",
				issueTitle: "语音产品设计",
				stageHint: "implement",
			},
			body: "PRD 写完了",
		});
		// FSM notified so an idle machine starts announcing
		expect(machine.events).toContainEqual({ type: "queue_pushed" });
	});

	it("unknown context still enqueues with a degraded channel-name headline (never silently dropped)", async () => {
		const { queue, core } = build();
		await core.onGatewayMessage(
			msg({ channelId: "chat-1", channelName: "eng-chat" }),
		);
		expect(queue.peek()?.headline.agentDisplay).toBe("eng-chat");
		expect(queue.peek()?.headline.issueRef).toBeUndefined();
	});

	it("a gate-bound message becomes a ship_gate item with the binding attached", async () => {
		const { bridge, queue, core } = build();
		bridge.bindings.set("500", {
			bound: true,
			questionId: "q-1",
			prHeadSha: "sha-1",
			issueId: "FLY-901",
			prNumber: 42,
		});
		await core.onGatewayMessage(msg({ authorId: "bridge-bot" }));
		const item = queue.peek();
		expect(item?.kind).toBe("ship_gate");
		expect(item?.gate).toEqual({
			gateMessageId: "500",
			questionId: "q-1",
			prHeadSha: "sha-1",
			issueId: "FLY-901",
			prNumber: 42,
		});
	});

	it("unknown BOT in a scope channel with a gate binding is rescued by the binding (filter ⑦)", async () => {
		const { bridge, queue, core } = build();
		bridge.bindings.set("500", {
			bound: true,
			questionId: "q",
			prHeadSha: "s",
			issueId: "FLY-9",
		});
		await core.onGatewayMessage(msg({ authorId: "unknown-bot" }));
		expect(queue.size()).toBe(1);
	});

	it("filters founder/self/stranger and roundtable-by-default", async () => {
		const { queue, core } = build();
		await core.onGatewayMessage(
			msg({ authorId: "annie-id", authorIsBot: false }),
		);
		await core.onGatewayMessage(msg({ authorId: "hp-bot" }));
		await core.onGatewayMessage(
			msg({ authorId: "random-user", authorIsBot: false }),
		);
		await core.onGatewayMessage(msg({ channelId: "rt-1" }));
		expect(queue.size()).toBe(0);
	});

	it("advances the per-channel cursor on EVERY message (filtered or not) and persists", async () => {
		const { core, saved } = build();
		await core.onGatewayMessage(msg({ id: "501" }));
		await core.onGatewayMessage(
			msg({ id: "502", authorId: "random-user", authorIsBot: false }),
		);
		expect(core.cursors["thread-906"]).toBe("502");
		expect(saved.length).toBeGreaterThan(0);
	});

	it("while mode is OFF messages only advance the cursor (no enqueue — she is on screen)", async () => {
		const { queue, core } = build({ modeOn: false });
		await core.onGatewayMessage(msg({ id: "600" }));
		expect(queue.size()).toBe(0);
		expect(core.cursors["thread-906"]).toBe("600");
	});
});

describe("HeadphoneDaemonCore — typed passphrase (core channel)", () => {
	it("founder typing 芝麻开门 in core turns mode ON and starts the machine", async () => {
		const { core, machine } = build({ modeOn: false });
		await core.onGatewayMessage(
			msg({
				channelId: "core-1",
				authorId: "annie-id",
				authorIsBot: false,
				content: "芝麻开门",
			}),
		);
		expect(core.modeOn).toBe(true);
		expect(machine.events).toContainEqual({ type: "start" });
	});

	it("founder typing 芝麻关门 routes into the machine as an utterance (confirm step applies)", async () => {
		const { core, machine } = build();
		await core.onGatewayMessage(
			msg({
				channelId: "core-1",
				authorId: "annie-id",
				authorIsBot: false,
				content: "芝麻关门",
			}),
		);
		expect(machine.events).toContainEqual({
			type: "utterance",
			text: "芝麻关门",
		});
	});

	it("a NON-founder typing the passphrase does nothing", async () => {
		const { core } = build({ modeOn: false });
		await core.onGatewayMessage(
			msg({
				channelId: "core-1",
				authorId: "random-user",
				authorIsBot: false,
				content: "芝麻开门",
			}),
		);
		expect(core.modeOn).toBe(false);
	});
});

describe("HeadphoneDaemonCore — offline backfill (recovery ledger ①)", () => {
	it("backfills missed messages per channel after the cursor, in snowflake order", async () => {
		const { bridge, queue, core } = build();
		bridge.contexts.set("thread-906", {
			kind: "issue_thread",
			issueId: "u",
			issueIdentifier: "FLY-906",
			issueTitle: "t",
			agentId: "tadashi",
		});
		core.cursors["thread-906"] = "100";
		const fetched: Array<{ channelId: string; after: string }> = [];
		await core.backfill(async (channelId, after) => {
			fetched.push({ channelId, after });
			if (channelId !== "thread-906") return [];
			// out of order on purpose — core must sort by snowflake
			return [msg({ id: "300" }), msg({ id: "200" })];
		});
		expect(fetched).toContainEqual({ channelId: "thread-906", after: "100" });
		expect(queue.size()).toBe(2);
		expect(queue.shift()?.messageId).toBe("200");
		expect(queue.shift()?.messageId).toBe("300");
		expect(core.cursors["thread-906"]).toBe("300");
	});

	it("backfill merges ALL channels globally by snowflake (cross-channel FIFO)", async () => {
		const { queue, core } = build();
		await core.backfill(async (channelId) => {
			if (channelId === "thread-906") return [msg({ id: "300" })];
			if (channelId === "chat-1") {
				return [
					msg({ id: "200", channelId: "chat-1", channelName: "eng-chat" }),
				];
			}
			return [];
		});
		// FIFO = arrival order across ALL channels, not per-channel batches
		expect(queue.shift()?.messageId).toBe("200");
		expect(queue.shift()?.messageId).toBe("300");
	});

	it("startup buffering: a live message during boot can NEVER advance the cursor past the offline gap (Codex R2 HIGH)", async () => {
		const { queue, core } = build();
		core.cursors["thread-906"] = "100";
		core.beginStartupBuffer();
		// live gateway delivery arrives BEFORE backfill fetches this channel
		await core.onGatewayMessage(msg({ id: "500" }));
		expect(core.cursors["thread-906"]).toBe("100"); // untouched
		expect(queue.size()).toBe(0); // buffered, not ingested
		await core.backfill(async (channelId, after) => {
			if (channelId !== "thread-906") return [];
			expect(after).toBe("100"); // pristine persisted cursor, not 500
			return [msg({ id: "200" }), msg({ id: "300" })];
		});
		await core.endStartupBuffer();
		// nothing lost, arrival order preserved: offline gap first, live last
		expect(queue.shift()?.messageId).toBe("200");
		expect(queue.shift()?.messageId).toBe("300");
		expect(queue.shift()?.messageId).toBe("500");
		expect(core.cursors["thread-906"]).toBe("500");
	});

	it("a live message arriving MID-DRAIN merges behind the buffered batch, never jumps the queue (Codex R3)", async () => {
		const { bridge, queue, core } = build();
		core.beginStartupBuffer();
		await core.onGatewayMessage(msg({ id: "300" }));
		// while item 300's ingest awaits its Bridge context lookup, a NEWER
		// live message (400) arrives — it must merge behind, not race ahead.
		let injected = false;
		const origGetContext = bridge.getContext.bind(bridge);
		bridge.getContext = async (channelId: string) => {
			if (!injected) {
				injected = true;
				await core.onGatewayMessage(msg({ id: "400" }));
			}
			return origGetContext(channelId);
		};
		await core.endStartupBuffer();
		expect(queue.shift()?.messageId).toBe("300");
		expect(queue.shift()?.messageId).toBe("400");
		expect(queue.size()).toBe(0);
	});

	it("startup buffering drains the buffer even when there is nothing to backfill", async () => {
		const { queue, core } = build();
		core.beginStartupBuffer();
		await core.onGatewayMessage(msg({ id: "700" }));
		await core.endStartupBuffer();
		expect(queue.size()).toBe(1);
	});

	it("backfill overlap with live messages dedupes via the queue (no double announce)", async () => {
		const { queue, core } = build();
		await core.onGatewayMessage(msg({ id: "700" }));
		await core.backfill(async (channelId) =>
			channelId === "thread-906" ? [msg({ id: "700" })] : [],
		);
		expect(queue.size()).toBe(1);
	});
});
