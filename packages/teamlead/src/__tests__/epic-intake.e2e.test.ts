import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { expect, it } from "vitest";
import { scanEpicIntakes } from "../bridge/epic-intake.js";
import { formatEpicIntake } from "../bridge/hook-payload.js";
import { enqueueLeadEvent } from "../bridge/lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import { epicShapeSnapshot } from "../epic-page/__tests__/fixtures/epic-shape.js";
import { generateEpicPage } from "../epic-page/generate.js";
import { renderEpicPageBundle } from "../epic-page/render-html.js";
import { StateStore } from "../StateStore.js";

it("keeps one intake through journal and mailbox reopen, ACK, pending card and scope exit", async () => {
	const directory = mkdtempSync(join(tmpdir(), "fly2557-e2e-"));
	let store = await StateStore.create(join(directory, "state.db"));
	let queue = new MailboxQueue(join(directory, "comm.db"));
	const at = "2026-09-14T20:00:00.000Z";
	const root = {
		id: "test-epic",
		identifier: "EPX-200",
		title: "Synthetic intake",
		url: "https://linear.app/example/issue/EPX-200",
		updatedAt: at,
		team: { key: "EPX" },
		project: null,
		labels: ["TestDepartment"],
		parent: null,
		state: { type: "started", name: "In Progress" },
		hasChildIssues: false,
		episodes: [
			{
				eventUid: `epic_intake:test-epic:${at}`,
				startedAt: at,
				endedAt: null as string | null,
				sourceSpanIds: ["test-span"],
				active: true,
			},
		],
	};
	const projects = [
		{
			projectName: "example",
			projectRoot: directory,
			linear: { team: "EPX" },
			leads: [
				{
					agentId: "test-lead",
					chatChannel: "test-channel",
					match: { labels: ["TestDepartment"] },
				},
			],
		},
	];
	const collect = async () => ({
		fetchedAt: at,
		candidates: [root],
		missingIssueIds: [],
	});
	try {
		// Producer succeeds but its caller loses the enqueue attempt.
		await expect(
			scanEpicIntakes({
				store,
				projects,
				projectName: "example",
				apiKey: "synthetic",
				collect,
				now: () => new Date(at),
				enqueue: () => {
					throw new Error("isolated enqueue interruption");
				},
			}),
		).rejects.toThrow("isolated enqueue interruption");
		const first = store.listEpicIntakes("example")[0];
		store.close();
		store = await StateStore.create(join(directory, "state.db"));
		const row = store.listUndeliveredLeadInboxEvents({
			leadId: "test-lead",
			projectName: "example",
		})[0];
		const envelope = leadEventEnvelopeFromJournalRow(row);
		const delivery = enqueueLeadEvent({
			queue,
			envelope,
			content: formatEpicIntake(envelope),
		});
		queue.close();
		queue = new MailboxQueue(join(directory, "comm.db"));
		await scanEpicIntakes({
			store,
			projects,
			projectName: "example",
			apiKey: "synthetic",
			collect,
			now: () => new Date(at),
			enqueue: (record) => {
				expect(record.eventUid).toBe(first.eventUid);
				expect(record.leadEventSeq).toBe(first.leadEventSeq);
				expect(
					enqueueLeadEvent({
						queue,
						envelope,
						content: formatEpicIntake(envelope),
					}).deliveryId,
				).toBe(delivery.deliveryId);
			},
		});
		expect(store.listEpicIntakes("example")).toHaveLength(1);
		const ackAt = "2099-09-14T20:00:00.000Z";
		queue.acquireOrRenewOwner({
			ownerEpoch: "isolated",
			now: ackAt,
			leaseTtlMs: 30_000,
		});
		expect(
			queue.claimLeadBatch({
				toAgent: "test-lead",
				msgClass: "model",
				ownerEpoch: "isolated",
				batchId: "isolated-batch",
				now: ackAt,
				claimTtlMs: 30_000,
			}),
		).toHaveLength(1);
		queue.ackBatchByRecipient({
			batchId: "isolated-batch",
			fromAgent: "test-lead",
			now: ackAt,
		});
		expect(queue.getById(delivery.deliveryId)).toMatchObject({
			state: "ACKED",
			acked_at: ackAt,
		});
		expect(store.listEpicIntakes("example")[0].workState).toBe("pending");
		const snapshot = epicShapeSnapshot();
		snapshot.fetchedAt = at;
		snapshot.roots = [{ ...root, startedAt: at }];
		snapshot.items = [];
		snapshot.descendantIds = [];
		const render = () =>
			renderEpicPageBundle(
				generateEpicPage({
					snapshot,
					itemFacts: [],
					intakes: store.listEpicIntakes("example"),
					now: new Date(at),
					projectName: "example",
					trigger: "scan",
				}),
				new Date(at),
			).html;
		expect(render()).toContain("待拆解（intake 于");
		expect(render()).toContain("Synthetic intake");
		root.state = { type: "backlog", name: "Backlog" };
		root.episodes[0].active = false;
		root.episodes[0].endedAt = "2026-09-14T20:01:00.000Z";
		await scanEpicIntakes({
			store,
			projects,
			projectName: "example",
			apiKey: "synthetic",
			collect,
			now: () => new Date("2026-09-14T20:01:00.000Z"),
			enqueue: () => {},
		});
		expect(store.listEpicIntakes("example")[0]).toMatchObject({
			active: false,
			pageDirty: true,
		});
		snapshot.roots = [];
		expect(render()).not.toContain("待拆解（intake 于");
	} finally {
		queue.close();
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
