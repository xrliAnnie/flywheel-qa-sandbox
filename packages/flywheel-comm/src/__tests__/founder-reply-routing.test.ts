import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeFounderReply as routeFounderReplyCommand } from "../commands/route-founder-reply.js";
import { CommDB } from "../db.js";
import {
	founderMessageRootId,
	founderRouteRowId,
} from "../founder-reply-routing.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

const T0 = "2026-07-21T12:00:00.000Z";
const T1 = "2026-07-21T12:01:00.000Z";

describe("FLY-1392 v2 Lead founder relay compatibility wrapper", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-founder-route-v2-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seedRoot(msgId = "discord-1"): string {
		const rootId = founderMessageRootId("lead-a", msgId);
		db.enqueueFounderHubRoot({
			id: rootId,
			toLead: "lead-a",
			content: JSON.stringify({
				v: 1,
				msgId,
				answer: "use option A",
				projectName: "flywheel",
				issueId: "FLY-1392",
				threadId: "thread-1",
			}),
			refMessageId: msgId,
			now: T0,
		});
		return rootId;
	}

	it("keeps stable ids while retiring Bridge-side attribution", () => {
		expect(founderMessageRootId("lead-a", "123")).toBe(
			"founder_msg:lead-a:123",
		);
		// This id remains only so in-flight v1 siblings can be read by the wrapper.
		expect(founderRouteRowId("lead-a", "123")).toBe("founder_route:lead-a:123");
	});

	it("atomically relays one canonical root, records the Lead evidence, and admits one wake", () => {
		const questionId = db.insertQuestion("exec-a", "lead-a", "which option?");
		const rootId = seedRoot();
		const input = {
			msgId: "discord-1",
			leadId: "lead-a",
			toQuestionId: questionId,
			now: T1,
			provenance: {
				senderLeaseKey: "lead-lease-a",
				senderGeneration: 17,
			},
			intentKey: `founder-route:lead-a:discord-1:${questionId}`,
			envelope: {
				id: `founder-route-wake:lead-a:discord-1:${questionId}`,
				to: "exec-a",
				content: "founder reply routed",
				metadata: { msgId: "discord-1", questionId },
			},
			queuedAtMs: Date.parse(T1),
		};

		const first = db.routeFounderReply(input);
		expect(first).toMatchObject({ kind: "routed", questionId });
		expect(db.routeFounderReply(input)).toEqual(first);
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: "lead-a",
			to_agent: "exec-a",
			content: "use option A",
		});
		const root = queue.getById(rootId);
		expect(root).toMatchObject({
			processed_at: T1,
			disposed_at: null,
			routing_state: "bound",
			next_unprocessed_at: null,
		});
		expect(JSON.parse(root?.processed_evidence ?? "null")).toMatchObject({
			kind: "lead_routed",
			actor: "lead-a",
			actor_kind: "lead",
			fence: { lease_generation: 17 },
			basis: [`question:${questionId}`],
		});
		expect(
			queue.getById(founderRouteRowId("lead-a", "discord-1")),
		).toBeUndefined();
		const wakes = db.listRunnerPhaseWakes("exec-a");
		expect(wakes).toHaveLength(1);
		expect(JSON.parse(wakes[0]?.envelope_json ?? "{}")).toMatchObject({
			metadata: { origin: "founder" },
		});
	});

	it("lets only Lead explicitly close a canonical founder receipt as no-route", () => {
		const rootId = seedRoot("discord-no-route");
		expect(
			db.routeFounderReply({
				msgId: "discord-no-route",
				leadId: "lead-a",
				noRouteReason: "lead_handled",
				now: T1,
				provenance: {
					senderLeaseKey: "lead-lease-a",
					senderGeneration: 17,
				},
			}),
		).toEqual({ kind: "no_route" });
		const root = queue.getById(rootId);
		expect(root).toMatchObject({
			processed_at: T1,
			disposed_at: null,
			routing_state: "no_route",
		});
		expect(JSON.parse(root?.processed_evidence ?? "null")).toMatchObject({
			kind: "lead_no_route",
			actor: "lead-a",
			basis: ["lead_handled"],
		});
	});

	it("rejects cross-scope and reserved-attribution relay attempts", () => {
		const questionId = db.insertQuestion("exec-a", "lead-a", "route me");
		seedRoot();
		expect(() =>
			db.routeFounderReply({
				msgId: "discord-1",
				leadId: "lead-b",
				toQuestionId: questionId,
				now: T1,
				provenance: { senderGeneration: 17 },
				intentKey: "wrong-lead",
				envelope: {
					id: "wrong-lead",
					to: "exec-a",
					content: "must reject",
				},
				queuedAtMs: Date.parse(T1),
			}),
		).toThrow(/unavailable/);
		expect(() =>
			routeFounderReplyCommand({
				msgId: "discord-1",
				leadId: "bridge",
				dbPath,
				toQuestionId: questionId,
				env: { FLYWHEEL_LEAD_LEASE_MODE: "off" },
			}),
		).toThrow(/reserved founder-side attribution/);
		expect(
			queue.getById(founderMessageRootId("lead-a", "discord-1")),
		).toMatchObject({
			processed_at: null,
			disposed_at: null,
		});
	});

	it("the CLI executes the same single-row Lead relay path", () => {
		const questionId = db.insertQuestion("exec-a", "lead-a", "route me");
		seedRoot();
		const result = routeFounderReplyCommand({
			msgId: "discord-1",
			leadId: "lead-a",
			dbPath,
			toQuestionId: questionId,
			env: { FLYWHEEL_LEAD_LEASE_MODE: "off" },
			now: () => new Date(T1),
		});
		expect(result).toMatchObject({ kind: "routed", questionId });
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: "lead-a",
			content: "use option A",
		});
		expect(
			queue.getById(founderRouteRowId("lead-a", "discord-1")),
		).toBeUndefined();
	});
});
