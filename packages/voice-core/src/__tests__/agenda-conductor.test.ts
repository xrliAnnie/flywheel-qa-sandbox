import { describe, expect, it } from "vitest";
import {
	type AgendaBriefRequestInput,
	AgendaConductor,
	type AgendaConductorOptions,
	type AgendaDispositionRecord,
	type AgendaItem,
	type AgendaPorts,
	type AgendaResult,
	type AgendaSnapshot,
	type AgendaState,
	agendaFallbackLine,
	defaultAgendaOrder,
	validateAgendaSay,
} from "../agenda/index.js";
import { FakeV1Session } from "../headphone/FakeV1Session.js";
import type { RoomBargeInEvent } from "../room-io.js";
import type { VoiceUtterance } from "../types.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

class FakeClock {
	t = 1_000_000;
	private seq = 0;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];
	now = () => this.t;
	setTimeout = ((fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
		return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;
	clearTimeout = ((handle: { id: number } | undefined) => {
		if (!handle) return;
		this.timers = this.timers.filter((timer) => timer.id !== handle.id);
	}) as unknown as typeof clearTimeout;
	async advance(ms: number): Promise<void> {
		const target = this.t + ms;
		for (;;) {
			const due = this.timers
				.filter((timer) => timer.at <= target)
				.sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			this.timers = this.timers.filter((timer) => timer.id !== due.id);
			this.t = due.at;
			due.fn();
			await settle();
		}
		this.t = target;
		await settle();
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 30; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeBridge implements AgendaPorts {
	snapshot: AgendaSnapshot = {
		snapshotId: "s1",
		asOf: new Date(0).toISOString(),
		items: [],
		sourceStatus: {},
		complete: true,
		olderUnspokenCount: 0,
	};
	stored?: AgendaState;
	dispositions: AgendaDispositionRecord[] = [];
	requests: Array<AgendaBriefRequestInput & { requestId: string }> = [];
	results = new Map<string, AgendaResult[]>();
	turns: Array<{ utteranceId: string; itemKey: string }> = [];
	failSnapshot = false;
	private nextRequest = 0;
	private nextSeq = new Map<string, number>();

	async fetchSnapshot(): Promise<AgendaSnapshot> {
		if (this.failSnapshot) throw new Error("bridge_down");
		return structuredClone(this.snapshot);
	}
	async loadState(): Promise<AgendaState | undefined> {
		return this.stored ? structuredClone(this.stored) : undefined;
	}
	async saveState(input: {
		state: AgendaState;
		expectedVersion: number;
		dispositions: readonly AgendaDispositionRecord[];
	}) {
		if ((this.stored?.stateVersion ?? 0) !== input.expectedVersion)
			return {
				ok: false as const,
				...(this.stored ? { current: structuredClone(this.stored) } : {}),
			};
		this.stored = structuredClone(input.state);
		this.dispositions.push(...input.dispositions);
		return { ok: true as const };
	}
	async requestBrief(input: AgendaBriefRequestInput) {
		const requestId = `req-${++this.nextRequest}`;
		this.requests.push({ ...input, requestId });
		return { requestId };
	}
	async listResults(requestId: string, after: number) {
		return (this.results.get(requestId) ?? []).filter(
			(result) => result.seq > after,
		);
	}
	async bindTurn(input: { utteranceId: string; itemKey: string }) {
		this.turns.push(input);
	}
	private push(requestId: string, build: (seq: number) => AgendaResult) {
		const seq = (this.nextSeq.get(requestId) ?? 0) + 1;
		this.nextSeq.set(requestId, seq);
		const list = this.results.get(requestId) ?? [];
		list.push(build(seq));
		this.results.set(requestId, list);
	}
	say(
		requestId: string,
		text: string,
		itemKey: string | null = null,
		order?: string[],
	) {
		this.push(requestId, (seq) => ({
			kind: "say",
			requestId,
			resultEventId: `${requestId}:e${seq}`,
			seq,
			itemKey,
			...(order ? { order } : {}),
			text,
		}));
	}
	leadReply(requestId: string, text: string) {
		this.push(requestId, (seq) => ({
			kind: "lead_reply",
			requestId,
			resultEventId: `${requestId}:e${seq}`,
			seq,
			text,
		}));
	}
	close(
		requestId: string,
		itemKey: string,
		disposition: "resolved" | "decision_recorded" | "deferred",
		evidence?: string,
	) {
		this.push(requestId, (seq) => ({
			kind: "close",
			requestId,
			resultEventId: `${requestId}:e${seq}`,
			seq,
			itemKey,
			disposition,
			...(evidence ? { evidence } : {}),
			reason: "她拍了",
		}));
	}
	last(): AgendaBriefRequestInput & { requestId: string } {
		const request = this.requests.at(-1);
		if (!request) throw new Error("no request");
		return request;
	}
}

class FakeRoom {
	drained = true;
	private listeners = new Set<(event: RoomBargeInEvent) => void>();
	audibleTail() {
		return {
			estimated: true as const,
			remainingMs: this.drained ? 0 : 500,
			drained: this.drained,
			observedAt: 0,
			sessionId: SESSION,
			generation: 1,
		};
	}
	onBargeIn(listener: (event: RoomBargeInEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	bargeIn(phase: RoomBargeInEvent["phase"]) {
		for (const listener of this.listeners)
			listener({
				sessionId: SESSION,
				generation: 1,
				utteranceId: "u-barge",
				owner: { kind: "known", speakerUserId: "founder" },
				startedAt: 0,
				observedAt: 0,
				durationMs: 0,
				phase,
			} as unknown as RoomBargeInEvent);
	}
}

function item(
	key: string,
	cls: AgendaItem["class"],
	sinceMinute: number,
	extra: Partial<AgendaItem> = {},
): AgendaItem {
	return {
		itemKey: key,
		class: cls,
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		leadName: "Tadashi",
		issueIdentifier: cls === "lead_said" ? null : `FLY-${key.length}796`,
		issueTitle: cls === "lead_said" ? null : "语音耳机",
		threadUrl:
			cls === "lead_said" ? null : "https://discord.com/channels/1/2/3",
		since: new Date(sinceMinute * 60_000).toISOString(),
		urgent: null,
		pointers: { messageIds: [] },
		...extra,
	};
}

interface Harness {
	clock: FakeClock;
	bridge: FakeBridge;
	room: FakeRoom;
	engine: FakeV1Session;
	events: Record<string, unknown>[];
	conductor: AgendaConductor;
	spoken(): string[];
	userSays(text: string): void;
}

async function harness(
	setup: (bridge: FakeBridge) => void = () => undefined,
	options: Partial<AgendaConductorOptions> & {
		bridge?: FakeBridge;
		generation?: number;
	} = {},
): Promise<Harness> {
	const clock = new FakeClock();
	const bridge = options.bridge ?? new FakeBridge();
	setup(bridge);
	const room = new FakeRoom();
	const engine = new FakeV1Session({
		sessionId: SESSION,
		generation: options.generation ?? 1,
	});
	await engine.open("ctx");
	const events: Record<string, unknown>[] = [];
	let ids = 0;
	const conductor = new AgendaConductor({
		mode: "headphone",
		sessionId: SESSION,
		generation: options.generation ?? 1,
		engine,
		room,
		ports: bridge,
		record: (event) => events.push(event),
		now: clock.now,
		setTimeoutFn: clock.setTimeout,
		clearTimeoutFn: clock.clearTimeout,
		nextId: () => `client-${++ids}`,
		...options,
	});
	return {
		clock,
		bridge,
		room,
		engine,
		events,
		conductor,
		spoken: () => engine.speakCalls.map((call) => call.text),
		userSays(text: string) {
			engine.emitUtterance({
				role: "user",
				final: true,
				text,
			} as unknown as VoiceUtterance);
		},
	};
}

async function wake(h: Harness, requestId: string): Promise<void> {
	await h.conductor.notifyResults(requestId);
	await settle();
}

const THREE = (bridge: FakeBridge) => {
	bridge.snapshot.items = [
		item("approve:A", "awaiting_approval", 1),
		item("approve:B", "awaiting_approval", 2),
		item("blocked:C", "blocked", 3),
	];
};

describe("AgendaConductor — opening (plan §3.1, §4.1 Q1/Q2)", () => {
	it("briefs the Lead with the whole batch and speaks only the Lead's words", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		expect(h.bridge.requests).toHaveLength(1);
		expect(h.bridge.last()).toMatchObject({ purpose: "open", itemKey: null });
		expect(h.spoken()).toEqual([]);
		// Default order: blocked, then the approvals by entry time.
		expect(h.bridge.stored?.queue).toEqual([
			"blocked:C",
			"approve:A",
			"approve:B",
		]);

		h.bridge.say(
			"req-1",
			"有三件要你拍：两张待批，一张受阻。先说受阻那张。",
			null,
			["blocked:C", "approve:B", "approve:A"],
		);
		await wake(h, "req-1");
		expect(h.spoken()).toEqual([
			"有三件要你拍：两张待批，一张受阻。先说受阻那张。",
		]);
		// Overview only → the head (after the Lead's order) is requested next.
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "blocked:C",
		});
		expect(h.bridge.stored?.active).toBe("blocked:C");
		expect(h.bridge.stored?.queue).toEqual(["approve:B", "approve:A"]);
		expect(h.engine.speakCalls[0]?.verification).toBe("required");
	});

	it("lets the opening say carry the first item without another round trip", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "三件事，先说二七九六。它卡在授权。", "blocked:C");
		await wake(h, "req-1");
		expect(h.bridge.requests).toHaveLength(1);
		expect(h.bridge.stored?.active).toBe("blocked:C");
	});

	it("rejects an order that is not a permutation of the opening batch", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说一件。", null, ["blocked:C", "approve:A"]);
		await wake(h, "req-1");
		expect(h.spoken()).toEqual([]);
		expect(h.events).toContainEqual(
			expect.objectContaining({
				kind: "agenda_result_rejected",
				reason: "matrix",
			}),
		);
	});

	it("still asks the Lead to open an empty agenda (natural first line)", async () => {
		const h = await harness();
		await h.conductor.start();
		expect(h.bridge.last()).toMatchObject({ purpose: "open" });
		h.bridge.say("req-1", "我在，现在没什么要你拍的。");
		await wake(h, "req-1");
		expect(h.spoken()).toEqual(["我在，现在没什么要你拍的。"]);
		expect(h.bridge.requests).toHaveLength(1);
	});
});

describe("AgendaConductor — one item at a time (§3.2 matrix, Q2-Q5)", () => {
	async function opened(): Promise<Harness> {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "三件，先说受阻那张。", "blocked:C");
		await wake(h, "req-1");
		return h;
	}

	it("closes the current item only through a reply bound to it, then opens the next", async () => {
		const h = await opened();
		const binding = h.conductor.bindTurn("utt-1");
		expect(binding).toEqual({ owner: "agenda", itemKey: "blocked:C" });
		await h.conductor.whenTurnBound("utt-1");
		expect(h.bridge.turns).toEqual([
			{ utteranceId: "utt-1", itemKey: "blocked:C" },
		]);
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.say("h-1", "好，我这就放行。", "blocked:C");
		h.bridge.close("h-1", "blocked:C", "resolved", "cmd:runner-resume:abc");
		await wake(h, "h-1");
		expect(h.spoken().at(-1)).toBe("好，我这就放行。");
		expect(h.bridge.dispositions).toEqual([
			expect.objectContaining({
				itemKey: "blocked:C",
				disposition: "resolved",
				evidence: "cmd:runner-resume:abc",
			}),
		]);
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:A",
			previous: { itemKey: "blocked:C", closedAs: "resolved" },
		});
	});

	it("refuses a resolved close without evidence", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.close("h-1", "blocked:C", "resolved");
		await wake(h, "h-1");
		expect(h.bridge.dispositions).toEqual([]);
		expect(h.bridge.stored?.active).toBe("blocked:C");
	});

	it("refuses to close an item that is not active", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.close("h-1", "approve:A", "deferred");
		await wake(h, "h-1");
		expect(h.bridge.dispositions).toEqual([]);
	});

	it("a verbal ship approval is recorded, not executed, and the talk moves on", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.close("h-1", "blocked:C", "resolved", "msg:1");
		await wake(h, "h-1");
		// approve:A is now active.
		h.bridge.say("req-2", "二七九六等你批，QA 过了。");
		// wrong: a say must be bound to the active item for an item request
		await wake(h, "req-2");
		expect(h.spoken().at(-1)).not.toBe("二七九六等你批，QA 过了。");
		h.bridge.say(
			"req-2",
			"二七九六等你批，QA 过了，你看要不要批？",
			"approve:A",
		);
		await wake(h, "req-2");
		h.conductor.bindTurn("utt-2");
		await h.conductor.adoptReply({ utteranceId: "utt-2", handoffId: "h-2" });
		h.bridge.say(
			"h-2",
			"我记下你批了，你在 thread 里点一下就行。",
			"approve:A",
		);
		h.bridge.close("h-2", "approve:A", "decision_recorded");
		await wake(h, "h-2");
		expect(h.bridge.dispositions.at(-1)).toMatchObject({
			itemKey: "approve:A",
			disposition: "decision_recorded",
		});
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:B",
		});
	});

	it("does not re-raise a deferred item in the same session even if it stays on the titles", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.close("h-1", "blocked:C", "deferred");
		await wake(h, "h-1");
		const before = h.bridge.requests.length;
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.requests).toHaveLength(before);
		expect(h.bridge.stored?.items["blocked:C"]?.status).toBe("closed");
	});

	it("queues a new item at the tail without interrupting", async () => {
		const h = await opened();
		h.bridge.snapshot.items.push(item("approve:D", "awaiting_approval", 0));
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.stored?.queue).toEqual([
			"approve:A",
			"approve:B",
			"approve:D",
		]);
		expect(h.bridge.stored?.active).toBe("blocked:C");
		expect(h.spoken()).toHaveLength(1);
	});

	it("goes idle when the queue empties and picks up a newcomer immediately", async () => {
		const h = await harness((bridge) => {
			bridge.snapshot.items = [item("blocked:C", "blocked", 1)];
		});
		await h.conductor.start();
		h.bridge.say("req-1", "一件受阻。", "blocked:C");
		await wake(h, "req-1");
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.close("h-1", "blocked:C", "deferred");
		await wake(h, "h-1");
		expect(h.events).toContainEqual({ kind: "agenda_idle" });
		expect(h.conductor.bindTurn("utt-idle")).toEqual({
			owner: "front",
			itemKey: null,
		});
		h.bridge.snapshot.items.push(item("approve:E", "awaiting_approval", 9));
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:E",
		});
	});
});

describe("AgendaConductor — sources (R1-6) and stale results (R1-5)", () => {
	it("never closes an item from an incomplete snapshot", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(h, "req-1");
		h.bridge.snapshot = {
			...h.bridge.snapshot,
			items: [],
			complete: false,
		};
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.stored?.active).toBe("blocked:C");
		expect(h.bridge.stored?.queue).toHaveLength(2);
		// recovery: the same items again are not duplicated
		THREE(h.bridge);
		h.bridge.snapshot.complete = true;
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.stored?.queue).toEqual(["approve:A", "approve:B"]);
	});

	it("a complete snapshot that drops the active item moves on and says why", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(h, "req-1");
		h.bridge.snapshot.items = h.bridge.snapshot.items.filter(
			(entry) => entry.itemKey !== "blocked:C",
		);
		await h.conductor.notifySourceChanged();
		await settle();
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:A",
			previous: { itemKey: "blocked:C", closedAs: "source_gone" },
		});
	});

	it("ignores results of a superseded request", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先总的说一下。");
		await wake(h, "req-1");
		// req-2 is the item request now; a late say on req-1 must stay silent.
		h.bridge.say("req-1", "迟到的开场。");
		await wake(h, "req-1");
		expect(h.spoken()).toEqual(["先总的说一下。"]);
		expect(h.events).toContainEqual(
			expect.objectContaining({
				kind: "agenda_result_stale",
				requestId: "req-1",
			}),
		);
	});
});

describe("AgendaConductor — urgent (§4.2)", () => {
	it("interrupts at a safe boundary and resumes the paused item afterwards", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(h, "req-1");
		h.room.drained = false;
		h.bridge.snapshot.items.push(
			item("said:X", "lead_said", 5, {
				urgent: { source: "lead_flag", reason: "production_down" },
			}),
		);
		const refreshed = h.conductor.notifySourceChanged();
		await settle();
		// Still speaking: no urgent request yet.
		expect(h.bridge.last().purpose).toBe("open");
		h.room.drained = true;
		await h.clock.advance(300);
		await refreshed;
		expect(h.bridge.last()).toMatchObject({
			purpose: "urgent",
			itemKey: "said:X",
		});
		expect(h.events).toContainEqual(
			expect.objectContaining({
				kind: "agenda_preempted",
				itemKey: "said:X",
				reason: "production_down",
				source: "lead_flag",
				pausedItemKey: "blocked:C",
			}),
		);
		const urgentRequest = h.bridge.last().requestId;
		h.bridge.say(urgentRequest, "插一句急的：生产挂了。", "said:X");
		await wake(h, urgentRequest);
		expect(h.conductor.bindTurn("utt-u")).toEqual({
			owner: "agenda",
			itemKey: "said:X",
		});
		await h.conductor.adoptReply({ utteranceId: "utt-u", handoffId: "h-u" });
		h.bridge.close("h-u", "said:X", "resolved", "msg:restart");
		await wake(h, "h-u");
		expect(h.bridge.last()).toMatchObject({
			purpose: "resume",
			itemKey: "blocked:C",
		});
		expect(h.bridge.stored?.active).toBe("blocked:C");
	});
});

describe("AgendaConductor — Lead latency and mechanical checks (§3.4, §3.5)", () => {
	it("bridges once, then speaks a known-facts fallback and never the raw text", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		await h.clock.advance(20_000);
		expect(h.spoken()).toEqual(["我在整理，有 3 件要你拍，马上说。"]);
		await h.clock.advance(20_000);
		const fallback = h.spoken().at(-1) ?? "";
		expect(fallback).toContain("在等你授权");
		expect(fallback).not.toMatch(/已发|发了|细节在 thread/u);
		expect(h.bridge.stored?.active).toBe("blocked:C");
		expect(h.events).toContainEqual(
			expect.objectContaining({ kind: "agenda_fallback_spoken" }),
		);
	});

	it("asks for one rewrite, then falls back", async () => {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(h, "req-1");
		h.bridge.snapshot.items = h.bridge.snapshot.items.filter(
			(entry) => entry.itemKey !== "blocked:C",
		);
		await h.conductor.notifySourceChanged();
		await settle();
		const itemRequest = h.bridge.last().requestId;
		h.bridge.say(itemRequest, "看这里 https://x.y/z", "approve:A");
		await wake(h, itemRequest);
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:A",
			rewriteReason: "url",
		});
		const rewrite = h.bridge.last().requestId;
		h.bridge.say(rewrite, "- 列表\n- 还是列表", "approve:A");
		await wake(h, rewrite);
		expect(h.spoken().at(-1)).toBe(
			agendaFallbackLine(h.bridge.stored!.items["approve:A"]!.item),
		);
		expect(h.spoken().join("")).not.toContain("https://");
	});

	it("mechanical validation covers length, urls, markdown, code and prefixes", () => {
		expect(validateAgendaSay("好的。")).toEqual({ ok: true });
		expect(validateAgendaSay("字".repeat(401))).toEqual({
			ok: false,
			reason: "too_long",
		});
		expect(validateAgendaSay("看 www.example.com")).toMatchObject({
			reason: "url",
		});
		expect(validateAgendaSay("## 标题")).toMatchObject({ reason: "markdown" });
		expect(validateAgendaSay("1. 第一")).toMatchObject({ reason: "markdown" });
		expect(validateAgendaSay("跑 `pnpm`")).toMatchObject({ reason: "code" });
		expect(validateAgendaSay("🤖[自动] 进度")).toMatchObject({
			reason: "automation_prefix",
		});
		expect(validateAgendaSay("📻 状态")).toMatchObject({
			reason: "automation_prefix",
		});
	});
});

describe("AgendaConductor — check-in (§4.3)", () => {
	it("asks the Lead for one check-in after ten quiet minutes and never stacks", async () => {
		const h = await harness();
		await h.conductor.start();
		h.bridge.say("req-1", "我在。");
		await wake(h, "req-1");
		await h.clock.advance(599_000);
		expect(h.bridge.requests.filter((r) => r.purpose === "checkin")).toEqual(
			[],
		);
		await h.clock.advance(1_000);
		const checkins = h.bridge.requests.filter((r) => r.purpose === "checkin");
		expect(checkins).toHaveLength(1);
		h.bridge.say(checkins[0]!.requestId, "我还在，没什么新事，你忙你的。");
		await wake(h, checkins[0]!.requestId);
		expect(h.spoken().at(-1)).toBe("我还在，没什么新事，你忙你的。");
	});

	it("speaks the fixed line when the Lead does not answer the check-in", async () => {
		const h = await harness();
		await h.conductor.start();
		h.bridge.say("req-1", "我在。");
		await wake(h, "req-1");
		await h.clock.advance(600_000);
		await h.clock.advance(20_000);
		expect(h.spoken().at(-1)).toBe("我还在，没卡住。");
		expect(
			h.bridge.requests.filter((r) => r.purpose === "checkin"),
		).toHaveLength(1);
	});

	it("founder speech counts as conversation", async () => {
		const h = await harness();
		await h.conductor.start();
		h.bridge.say("req-1", "我在。");
		await wake(h, "req-1");
		await h.clock.advance(400_000);
		h.userSays("我在开车");
		await h.clock.advance(400_000);
		expect(h.bridge.requests.filter((r) => r.purpose === "checkin")).toEqual(
			[],
		);
	});

	it("rejects a non-positive interval", () => {
		expect(
			() =>
				new AgendaConductor({
					mode: "headphone",
					sessionId: SESSION,
					generation: 1,
					engine: new FakeV1Session(),
					room: new FakeRoom(),
					ports: new FakeBridge(),
					record: () => undefined,
					checkinIntervalMs: 0,
				}),
		).toThrow(/checkinIntervalMs/u);
	});
});

describe("AgendaConductor — turns (§4.4 R-T1..R-T5, Q7)", () => {
	async function opened(): Promise<Harness> {
		const h = await harness(THREE);
		await h.conductor.start();
		h.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(h, "req-1");
		return h;
	}

	it("a turn keeps the item it started on even after that item closes", async () => {
		const h = await opened();
		expect(h.conductor.bindTurn("utt-late")).toEqual({
			owner: "agenda",
			itemKey: "blocked:C",
		});
		// C disappears from a complete snapshot while she is still talking.
		h.bridge.snapshot.items = h.bridge.snapshot.items.filter(
			(entry) => entry.itemKey !== "blocked:C",
		);
		await h.conductor.notifySourceChanged();
		await settle();
		const itemRequest = h.bridge.last().requestId;
		expect(h.bridge.stored?.active).toBe("approve:A");
		// Her late final arrives; the binding did not move.
		expect(h.conductor.bindTurn("utt-late")).toEqual({
			owner: "agenda",
			itemKey: "blocked:C",
		});
		await h.conductor.adoptReply({
			utteranceId: "utt-late",
			handoffId: "h-late",
		});
		// The old item request's late draft is now stale.
		h.bridge.say(itemRequest, "旧稿。", "approve:A");
		await wake(h, itemRequest);
		expect(h.spoken()).not.toContain("旧稿。");
		// Closing the closed item is refused; an explanation is spoken.
		h.bridge.close("h-late", "blocked:C", "deferred");
		h.bridge.say("h-late", "那张刚才已经不卡了。", "blocked:C");
		await wake(h, "h-late");
		expect(h.spoken().at(-1)).toBe("那张刚才已经不卡了。");
		expect(h.bridge.dispositions).toEqual([]);
		expect(h.bridge.stored?.active).toBe("approve:A");
		expect(h.bridge.last()).toMatchObject({
			purpose: "item",
			itemKey: "approve:A",
		});
	});

	it("a plain Lead reply on an agenda turn is spoken for the bound item", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.leadReply("h-1", "卡在权限，要你点头。");
		await wake(h, "h-1");
		expect(h.spoken().at(-1)).toBe("卡在权限，要你点头。");
	});

	it("an off-topic answer without the current item triggers one resume after the gap", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.say("h-1", "明天是晴天。", null);
		await wake(h, "h-1");
		await h.clock.advance(8_000);
		expect(h.bridge.last()).toMatchObject({
			purpose: "resume",
			itemKey: "blocked:C",
		});
	});

	it("an answer that already carries the current item needs no resume", async () => {
		const h = await opened();
		h.conductor.bindTurn("utt-1");
		await h.conductor.adoptReply({ utteranceId: "utt-1", handoffId: "h-1" });
		h.bridge.say("h-1", "明天晴天。回到受阻那张，要你授权。", "blocked:C");
		await wake(h, "h-1");
		const before = h.bridge.requests.length;
		await h.clock.advance(8_000);
		expect(h.bridge.requests).toHaveLength(before);
	});
});

describe("AgendaConductor — restart (Q8)", () => {
	it("continues from the stored cursor without re-applying results", async () => {
		const first = await harness(THREE);
		await first.conductor.start();
		first.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(first, "req-1");
		await first.conductor.close();

		const second = await harness(() => undefined, { bridge: first.bridge });
		await second.conductor.start();
		expect(second.bridge.stored?.active).toBe("blocked:C");
		expect(second.spoken()).toEqual([]);
		expect(second.bridge.requests).toHaveLength(1);
	});

	it("a new generation invalidates the old request and resumes the active item", async () => {
		const first = await harness(THREE);
		await first.conductor.start();
		first.bridge.say("req-1", "先说受阻。", "blocked:C");
		await wake(first, "req-1");
		await first.conductor.close();

		const second = await harness(() => undefined, {
			bridge: first.bridge,
			generation: 2,
		});
		await second.conductor.start();
		expect(second.bridge.last()).toMatchObject({
			purpose: "resume",
			itemKey: "blocked:C",
		});
		expect(second.bridge.stored?.generation).toBe(2);
	});
});

describe("defaultAgendaOrder", () => {
	it("orders blocked, approval, answer, Lead said, then by entry time", () => {
		const order = defaultAgendaOrder([
			item("said:1", "lead_said", 1),
			item("answer:1", "needs_answer", 1),
			item("approve:2", "awaiting_approval", 2),
			item("approve:1", "awaiting_approval", 1),
			item("blocked:9", "blocked", 9),
		]).map((entry) => entry.itemKey);
		expect(order).toEqual([
			"blocked:9",
			"approve:1",
			"approve:2",
			"answer:1",
			"said:1",
		]);
	});
});
