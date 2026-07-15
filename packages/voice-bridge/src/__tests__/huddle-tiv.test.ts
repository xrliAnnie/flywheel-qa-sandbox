/**
 * huddleTiv (FLY-545) — the /meet adapter over the SHARED TivPresenter
 * (FLY-1065). Verifies the merge contract: huddle presence vocabulary →
 * status line, multi-speaker captions keep the presenter's scrub/name
 * discipline, warn → error, and cards post AWAITED (conclusion proof).
 */
import { describe, expect, it, vi } from "vitest";
import { TivPresenter } from "../discord/TivPresenter.js";
import { createHuddleTiv, PRESENCE_LINE } from "../huddle/huddleTiv.js";

function setup() {
	const sent: string[] = [];
	const edits: [string, string][] = [];
	const presenter = new TivPresenter({
		deps: {
			send: async (t) => {
				sent.push(t);
			},
			sendForId: async (t) => {
				sent.push(t);
				return { messageId: `m${sent.length}` };
			},
			edit: async (id, t) => {
				edits.push([id, t]);
			},
		},
		statusThrottleMs: 0,
	});
	const cards: string[] = [];
	const tiv = createHuddleTiv({
		presenter,
		postCard: async (c) => {
			cards.push(c);
		},
	});
	return { tiv, sent, edits, cards };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("createHuddleTiv — presence → shared status line", () => {
	it("maps every huddle state to its emoji line (incl. the F2a connecting guard)", async () => {
		const { tiv, sent } = setup();
		tiv.presence("connecting", "正在接入 Tadashi (1/2)");
		await flush();
		expect(sent).toEqual(["🔌 连接中(先别说话) · 正在接入 Tadashi (1/2)"]);
	});

	it("detail-less presence renders the bare line", async () => {
		const { tiv, sent } = setup();
		tiv.presence("listening");
		await flush();
		expect(sent).toEqual([PRESENCE_LINE.listening]);
	});
});

describe("createHuddleTiv — captions route through the shared scrubber with the huddle's speaker names", () => {
	it("founder caption renders as user with her name", async () => {
		const { tiv, sent } = setup();
		tiv.caption("Annie", "内存这块怎么弄");
		await flush();
		expect(sent).toEqual(["🗣️ **Annie**:内存这块怎么弄"]);
	});

	it("lead caption renders as assistant with the LEAD's display name (not 助理)", async () => {
		const { tiv, sent } = setup();
		tiv.caption("Tadashi", "先落一个 plan");
		await flush();
		expect(sent).toEqual(["💬 **Tadashi**:先落一个 plan"]);
	});
});

describe("createHuddleTiv — warn and cards", () => {
	it("warn posts fail-visible through the presenter's error surface", async () => {
		const { tiv, sent } = setup();
		tiv.warn("闪断已自动接回");
		await flush();
		expect(sent).toEqual(["⚠️ 闪断已自动接回"]);
	});

	it("card is AWAITED and bypasses the status machinery (conclusion proof)", async () => {
		const { tiv, cards, sent } = setup();
		await tiv.card("## 结论\n1. x");
		expect(cards).toEqual(["## 结论\n1. x"]);
		expect(sent).toEqual([]); // not routed through throttled sends
	});

	it("card failures propagate to the caller (landing must SEE the failure)", async () => {
		const presenter = new TivPresenter({
			deps: {
				send: async () => {},
				sendForId: async () => ({ messageId: "m" }),
				edit: async () => {},
			},
		});
		const tiv = createHuddleTiv({
			presenter,
			postCard: vi.fn(async () => {
				throw new Error("discord down");
			}),
		});
		await expect(tiv.card("x")).rejects.toThrow("discord down");
	});
});
