/**
 * FLY-598: founder-ux gate — crown-jewel verification tests.
 *
 * Proves the anti-forgery security property: only a message AUTHORED BY THE
 * FOUNDER, present IN the issue thread, and FRESH can write a sign-off. A Lead
 * citing its own (or any non-founder) message id is rejected; a message id not
 * in the thread is rejected; a stale message is rejected; no founder id =>
 * fail-closed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../../StateStore.js";
import type { FetchImpl } from "../../founder-consent/discord-fetch.js";
import { signoffSatisfies } from "../signoff.js";
import {
	type FounderUxVerifyDeps,
	verifyAndRecordFounderUxSignoff,
} from "../verify.js";

const FOUNDER = "annie-discord-id";
const UX_HASH = "c".repeat(64);

interface RawMsg {
	id: string;
	content: string;
	timestamp: string;
	author?: { id?: string; bot?: boolean };
}

/** A fake Discord REST fetch returning `messages` as the thread's history. */
function fakeFetch(messages: RawMsg[]): FetchImpl {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => messages,
	})) as unknown as FetchImpl;
}

describe("FLY-598 verifyAndRecordFounderUxSignoff (crown jewel)", () => {
	let store: StateStore;
	const nowMs = Date.parse("2026-06-27T00:00:00Z");
	const fresh = "2026-06-26T23:00:00Z"; // 1h old
	const stale = "2026-06-20T00:00:00Z"; // 7d old

	const deps = (
		over: Partial<FounderUxVerifyDeps> & { messages?: RawMsg[] },
	): FounderUxVerifyDeps => ({
		store,
		resolveThread: () => ({ threadId: "thread-1", botToken: "bot-tok" }),
		founderUserId: FOUNDER,
		fetchImpl: fakeFetch(over.messages ?? []),
		now: () => nowMs,
		...over,
	});

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "ISSUE-1",
			project_name: "proj",
			status: "running",
		});
	});

	const annieMsg = (id = "msg-annie"): RawMsg => ({
		id,
		content: "可以，就这样做",
		timestamp: fresh,
		author: { id: FOUNDER, bot: false },
	});

	it("ALLOWS + records a sign-off for a fresh, in-thread, founder-authored message", async () => {
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ messages: [annieMsg()] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-annie" },
		);
		expect(res.ok).toBe(true);
		expect(signoffSatisfies(store, "exec-1", UX_HASH)).toBe(true);
	});

	it("FAIL-CLOSED (503) when no founder id is configured", async () => {
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ founderUserId: "", messages: [annieMsg()] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-annie" },
		);
		expect(res).toMatchObject({ ok: false, status: 503 });
		expect(signoffSatisfies(store, "exec-1", UX_HASH)).toBe(false);
	});

	it("DENIES (403) a message authored by a NON-founder (Lead forgery attempt)", async () => {
		const leadMsg: RawMsg = {
			id: "msg-lead",
			content: "approved on Annie's behalf", // a Lead trying to forge
			timestamp: fresh,
			author: { id: "lead-bot-id", bot: true },
		};
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ messages: [leadMsg] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-lead" },
		);
		expect(res).toMatchObject({ ok: false, status: 403 });
		expect(signoffSatisfies(store, "exec-1", UX_HASH)).toBe(false);
	});

	it("DENIES (422) a message id NOT present in the issue thread (thread binding)", async () => {
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ messages: [annieMsg("some-other-msg")] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "not-in-thread" },
		);
		expect(res).toMatchObject({ ok: false, status: 422 });
		expect(signoffSatisfies(store, "exec-1", UX_HASH)).toBe(false);
	});

	it("DENIES (422) a stale founder message (outside freshness window)", async () => {
		const old = annieMsg();
		old.timestamp = stale;
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ messages: [old] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-annie" },
		);
		expect(res).toMatchObject({ ok: false, status: 422 });
	});

	it("DENIES (422) when no Discord thread is registered for the run", async () => {
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ resolveThread: () => null, messages: [annieMsg()] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-annie" },
		);
		expect(res).toMatchObject({ ok: false, status: 422 });
	});

	it("DENIES (502) when the Discord fetch fails", async () => {
		const throwingFetch = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as FetchImpl;
		const res = await verifyAndRecordFounderUxSignoff(
			deps({ fetchImpl: throwingFetch, messages: [annieMsg()] }),
			{ executionId: "exec-1", uxHash: UX_HASH, annieMsgId: "msg-annie" },
		);
		expect(res).toMatchObject({ ok: false, status: 502 });
	});

	it("does NOT trust a CLI quote — stores the SERVER-FETCHED content excerpt", async () => {
		await verifyAndRecordFounderUxSignoff(deps({ messages: [annieMsg()] }), {
			executionId: "exec-1",
			uxHash: UX_HASH,
			annieMsgId: "msg-annie",
		});
		const raw = store.getSession("exec-1")?.founder_ux_signoff_json ?? "{}";
		expect(JSON.parse(raw).fetchedExcerpt).toBe("可以，就这样做");
	});
});
