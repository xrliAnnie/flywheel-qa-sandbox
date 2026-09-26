import { describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { type DetectionEscalationRow, StateStore } from "../../StateStore.js";
import {
	createFleetSink,
	createFounderPager,
	createSessionTargetResolver,
	type FounderPageTarget,
} from "../detection-escalation-sinks.js";

/**
 * FLY-1048 PR-C Task C3-w: the PRODUCTION implementations of the two sinks
 * `reconcileDetectionEscalations` injects.
 *
 * pageFounder contract (plan C3, Codex R1 #3): return true ONLY on a CONFIRMED
 * posted page. No thread / POST failure ⇒ false + `onUndeliverable` closes the
 * loop (never silent), and the row stays LEAD_NOTIFIED for the next reconcile.
 * `founder_page_ledger` makes the page once-per-episode across restarts.
 *
 * fleetSink contract (PRD §4.3 boundary): exactly ONE aggregate ticket for the
 * whole same-kind group, zero founder pages, and a THROW on sink failure so the
 * caller leaves every row LEAD_NOTIFIED. The aggregate body carries kind +
 * count + a target summary and NEVER any raw pane text (privacy boundary the
 * committed Lead leg already established).
 */

function row(
	over: Partial<DetectionEscalationRow> = {},
): DetectionEscalationRow {
	return {
		target_key: "exec-1",
		kind: "detection_stuck_confirmed",
		episode_fingerprint: "fp-1",
		issue_id: "issue-1",
		owner_lead_id: "flywheel-eng-lead",
		first_detected_at_ms: 0,
		lead_notified_at_ms: 1_000,
		lead_ack_at_ms: null,
		founder_paged_at_ms: null,
		clearing_since_ms: null,
		status: "LEAD_NOTIFIED",
		attempts: 0,
		...over,
	};
}

const TARGET: FounderPageTarget = {
	executionId: "exec-1",
	issueId: "issue-1",
	issueIdentifier: "FLY-999",
	projectName: "flywheel",
	chatChannel: "chan-1",
	botToken: "bot-token",
};

async function pagerHarness(
	over: {
		emitResult?: { kind: string; skipReason?: string };
		resolveTarget?: () => FounderPageTarget | null;
		addMember?: (
			threadId: string,
			userId: string,
			botToken: string,
			deps?: unknown,
		) => Promise<"added" | "transient" | "permanent">;
		bindThreadId?: string;
	} = {},
) {
	const store = await StateStore.create(":memory:");
	if (over.bindThreadId) {
		// FLY-1189: bind the issue thread so getChatThreadByIssue resolves and the
		// founder member-add leg is reached (TARGET.issueId / TARGET.chatChannel).
		store.upsertChatThread(
			over.bindThreadId,
			TARGET.chatChannel,
			TARGET.issueId,
			"flywheel-eng-lead",
		);
	}
	const undeliverable: string[] = [];
	const emitted: Array<Record<string, unknown>> = [];
	const emit = vi.fn(async (opts: Record<string, unknown>) => {
		emitted.push(opts);
		const result = over.emitResult ?? { kind: "posted" };
		if (result.kind !== "posted") {
			await (opts.onUndeliverable as (r: string) => Promise<void>)(
				result.skipReason ?? "permanent-500",
			);
		}
		return result as never;
	});
	const pageFounder = createFounderPager({
		store,
		resolveTarget: over.resolveTarget ?? (() => TARGET),
		discordOwnerUserId: "1234567890123456789",
		discordBotToken: "fallback-token",
		onUndeliverable: (_r, reason) => {
			undeliverable.push(reason);
		},
		emit: emit as never,
		addMember: over.addMember as never,
		now: () => 1_000 + 1_800_000,
	});
	return { store, pageFounder, undeliverable, emitted, emit };
}

describe("FLY-1048 C3-w createFounderPager", () => {
	it("returns true and records the ledger when the page is CONFIRMED posted", async () => {
		const h = await pagerHarness();
		await expect(h.pageFounder(row())).resolves.toBe(true);
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(h.undeliverable).toEqual([]);
		// Monotonic once-per-episode ledger (survives restart).
		expect(
			h.store.getFounderPaged(
				"detection-escalation-page-exec-1-detection_stuck_confirmed-fp-1",
			),
		).toBe(true);
	});

	it("FLY-1189: adds the founder as a thread member via the OWNER-LEAD bot before paging", async () => {
		const addMember = vi.fn(async () => "added" as const);
		const h = await pagerHarness({ addMember, bindThreadId: "thread-xyz" });
		await expect(h.pageFounder(row())).resolves.toBe(true);
		// Uses the OWNER-LEAD bot (TARGET.botToken), NOT the shared "fallback-token",
		// and targets the FOUNDER's id (discordOwnerUserId), not the owner Lead.
		expect(addMember).toHaveBeenCalledTimes(1);
		expect(addMember).toHaveBeenCalledWith(
			"thread-xyz",
			"1234567890123456789",
			"bot-token",
			expect.anything(),
		);
	});

	it("FLY-1189: skips member-add (never the shared Bridge bot) when the owner-Lead bot token is absent", async () => {
		const addMember = vi.fn(async () => "added" as const);
		const h = await pagerHarness({
			addMember,
			bindThreadId: "thread-xyz",
			resolveTarget: () => ({ ...TARGET, botToken: undefined }),
		});
		await expect(h.pageFounder(row())).resolves.toBe(true);
		// Must NOT fall back to deps.discordBotToken (the shared Bridge bot 403s on a
		// Lead-owned thread) — log-and-skip instead. The page itself still fires.
		expect(addMember).not.toHaveBeenCalled();
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("FLY-1189: a failed member-add never wedges the page", async () => {
		const addMember = vi.fn(async () => "permanent" as const);
		const h = await pagerHarness({ addMember, bindThreadId: "thread-xyz" });
		// Non-fatal by contract: the mention still fires and the page still posts.
		await expect(h.pageFounder(row())).resolves.toBe(true);
		expect(addMember).toHaveBeenCalledTimes(1);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("@-mentions the FOUNDER (discordOwnerUserId), not the owner Lead", async () => {
		const h = await pagerHarness();
		await h.pageFounder(row());
		expect(h.emitted[0]?.mentionUserId).toBe("1234567890123456789");
	});

	it("never leaks raw pane text — body carries kind + target + elapsed only", async () => {
		const h = await pagerHarness();
		await h.pageFounder(row());
		const content = String(h.emitted[0]?.content);
		expect(content).toContain("FLY-999");
		expect(content).toContain("exec-1");
		expect(content).toMatch(/30\s*分钟|30 min/);
		expect(content).not.toMatch(/pane|Traceback|\$ /i);
	});

	it("returns false + closes onUndeliverable when no target resolves", async () => {
		const h = await pagerHarness({ resolveTarget: () => null });
		await expect(h.pageFounder(row())).resolves.toBe(false);
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.undeliverable).toEqual(["no_target"]);
	});

	it("returns false when the post permanently fails (row stays LEAD_NOTIFIED)", async () => {
		const h = await pagerHarness({ emitResult: { kind: "permanent_failed" } });
		await expect(h.pageFounder(row())).resolves.toBe(false);
		expect(h.undeliverable).toEqual(["permanent-500"]);
		expect(
			h.store.getFounderPaged(
				"detection-escalation-page-exec-1-detection_stuck_confirmed-fp-1",
			),
		).toBe(false);
	});

	it("returns false when there is no bound chat thread", async () => {
		const h = await pagerHarness({
			emitResult: { kind: "skipped", skipReason: "no_chat_thread" },
		});
		await expect(h.pageFounder(row())).resolves.toBe(false);
		expect(h.undeliverable).toEqual(["no_chat_thread"]);
	});

	it("dedups: a second page for the same episode short-circuits to true without re-posting", async () => {
		const h = await pagerHarness();
		await h.pageFounder(row());
		await expect(h.pageFounder(row())).resolves.toBe(true);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("a prior FAILED page does not block a later retry", async () => {
		const h = await pagerHarness({ emitResult: { kind: "permanent_failed" } });
		await h.pageFounder(row());
		expect(h.emit).toHaveBeenCalledTimes(1);
		// Ledger holds `false` — the next reconcile MUST retry, not short-circuit.
		const h2 = createFounderPager({
			store: h.store,
			resolveTarget: () => TARGET,
			discordOwnerUserId: "1234567890123456789",
			onUndeliverable: () => {},
			emit: (async () => ({ kind: "posted" })) as never,
			now: () => 1_000 + 1_800_000,
		});
		await expect(h2(row())).resolves.toBe(true);
	});
});

function fleetHarness(over: { fail?: boolean } = {}) {
	const alerts: AlertPayload[] = [];
	const alertSink = {
		alert: vi.fn(async (p: AlertPayload) => {
			if (over.fail) throw new Error("sink down");
			alerts.push(p);
			return { sent: true };
		}),
	};
	const fleetSink = createFleetSink({ alertSink });
	return { alerts, alertSink, fleetSink };
}

describe("FLY-1048 C3-w createFleetSink", () => {
	const group = [
		row({ target_key: "exec-1", episode_fingerprint: "fp-1" }),
		row({ target_key: "exec-2", episode_fingerprint: "fp-2" }),
		row({ target_key: "exec-3", episode_fingerprint: "fp-3" }),
		row({ target_key: "exec-4", episode_fingerprint: "fp-4" }),
	];

	it("emits exactly ONE aggregate ticket for the whole same-kind group", async () => {
		const h = fleetHarness();
		await h.fleetSink("detection_stuck_confirmed", group);
		expect(h.alertSink.alert).toHaveBeenCalledTimes(1);
		expect(h.alerts[0]?.eventType).toBe("detection_fleet_aggregate");
	});

	it("body carries kind + count + target summary, and no pane text", async () => {
		const h = fleetHarness();
		await h.fleetSink("detection_stuck_confirmed", group);
		const body = h.alerts[0]?.body ?? "";
		expect(body).toContain("detection_stuck_confirmed");
		expect(body).toContain("4");
		expect(body).toContain("exec-1");
		expect(body).not.toMatch(/pane|Traceback/i);
	});

	it("eventId is deterministic for the same episode set (claims-dedup safe)", async () => {
		const a = fleetHarness();
		const b = fleetHarness();
		await a.fleetSink("detection_stuck_confirmed", group);
		await b.fleetSink("detection_stuck_confirmed", [...group].reverse());
		expect(a.alerts[0]?.eventId).toBe(b.alerts[0]?.eventId);
	});

	it("a different episode set yields a different eventId", async () => {
		const a = fleetHarness();
		const b = fleetHarness();
		await a.fleetSink("detection_stuck_confirmed", group);
		await b.fleetSink("detection_stuck_confirmed", group.slice(0, 3));
		expect(a.alerts[0]?.eventId).not.toBe(b.alerts[0]?.eventId);
	});

	it("THROWS when the sink fails so the caller leaves rows LEAD_NOTIFIED", async () => {
		const h = fleetHarness({ fail: true });
		await expect(
			h.fleetSink("detection_stuck_confirmed", group),
		).rejects.toThrow(/sink down/);
	});
});

/**
 * C3-w plugin glue, extracted testable: map an episode row's target_key
 * (a runner executionId) to its founder-page routing — the owner Lead's chat
 * channel + bot token via the SAME dept-label resolution the stuck flow uses
 * (resolveLeadForIssue; PRD §4.5: owner Lead ≠ 一律 eng). Anything
 * unresolvable returns null so the pager surfaces `no_target` instead of
 * addressing a page into a hole.
 */
describe("FLY-1048 C3-w createSessionTargetResolver", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/does-not-matter",
			leads: [
				{
					agentId: "flywheel-eng-lead",
					chatChannel: "chan-eng",
					match: { labels: ["flywheel"] },
					botToken: "eng-token",
				},
				{
					agentId: "flywheel-product-lead",
					chatChannel: "chan-prod",
					match: { labels: ["product"] },
					botToken: "prod-token",
				},
			],
		},
	];

	async function storeWithSession(over: Record<string, unknown> = {}) {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "flywheel",
			status: "running",
			issue_identifier: "FLY-999",
			...over,
		});
		return store;
	}

	it("resolves a runner session to its default Lead's thread routing", async () => {
		const store = await storeWithSession();
		const resolve = createSessionTargetResolver({ store, projects });
		expect(resolve(row())).toEqual({
			executionId: "exec-1",
			issueId: "issue-1",
			issueIdentifier: "FLY-999",
			projectName: "flywheel",
			chatChannel: "chan-eng",
			botToken: "eng-token",
		});
	});

	it("dept-label routing picks the MATCHING lead, not the first (PRD §4.5)", async () => {
		const store = await storeWithSession({
			issue_labels: JSON.stringify(["product"]),
		});
		const resolve = createSessionTargetResolver({ store, projects });
		const target = resolve(row());
		expect(target?.chatChannel).toBe("chan-prod");
		expect(target?.botToken).toBe("prod-token");
	});

	it("returns null for an unknown session (lead-keyed or vanished target)", async () => {
		const store = await StateStore.create(":memory:");
		const resolve = createSessionTargetResolver({ store, projects });
		expect(resolve(row())).toBeNull();
	});

	it("returns null when the session's project has no lead config", async () => {
		const store = await storeWithSession({ project_name: "ghost-project" });
		const resolve = createSessionTargetResolver({ store, projects });
		expect(resolve(row())).toBeNull();
	});
});

/**
 * FLY-1048 Codex code R1 #3: issue_id is a Linear UUID — deriving the project
 * from it routed every fleet aggregate to unknown-lead/deadletter. The sink
 * resolves the project through the injected resolver (plugin wires sessions).
 */
describe("createFleetSink — project resolution (Codex R1 #3)", () => {
	it("routes with the resolver's project name, falling back to unknown", async () => {
		const alerts: Array<{ projectName: string; leadId: string }> = [];
		const sink = createFleetSink({
			alertSink: {
				alert: async (p) => {
					alerts.push({ projectName: p.projectName, leadId: p.leadId });
					return { sent: true } as AlertResult;
				},
			},
			resolveProject: (row) => (row.target_key === "exec-1" ? "geo" : null),
		});
		await sink("detection_stuck_confirmed", [
			row({ target_key: "exec-1", episode_fingerprint: "fp:a" }),
			row({ target_key: "exec-gone", episode_fingerprint: "fp:b" }),
			row({ target_key: "exec-1", episode_fingerprint: "fp:c" }),
		]);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.projectName).toBe("geo"); // most common resolved name
	});

	it("the (project, lead) pair comes from ONE row — never a cross-project composite (Codex R2 #2)", async () => {
		const alerts: Array<{ projectName: string; leadId: string }> = [];
		const sink = createFleetSink({
			alertSink: {
				alert: async (p) => {
					alerts.push({ projectName: p.projectName, leadId: p.leadId });
					return { sent: true } as AlertResult;
				},
			},
			resolveProject: (r) =>
				r.target_key.startsWith("alpha") ? "alpha" : "beta",
		});
		await sink("detection_stuck_confirmed", [
			// two alpha rows WITHOUT an owner lead — alpha wins the project mode
			row({
				target_key: "alpha-1",
				episode_fingerprint: "fp:a1",
				owner_lead_id: null,
			}),
			row({
				target_key: "alpha-2",
				episode_fingerprint: "fp:a2",
				owner_lead_id: null,
			}),
			// one beta row with a lead — the only VALID pair
			row({
				target_key: "beta-1",
				episode_fingerprint: "fp:b1",
				owner_lead_id: "b-lead",
			}),
		]);
		expect(alerts).toEqual([{ projectName: "beta", leadId: "b-lead" }]);
	});
});
