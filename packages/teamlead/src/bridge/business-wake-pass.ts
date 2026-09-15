import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { MailboxSettlement } from "flywheel-comm/mailbox-queue";
import { resolveFounderTimezone } from "flywheel-config";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { LeadEventRow, StateStore } from "../StateStore.js";
import {
	latestBusinessWakeDue,
	parseBusinessWakeSchedule,
} from "./business-wake-schedule.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";

export async function readBusinessWakeFile(workspace: string) {
	const root = await realpath(workspace);
	const state = join(root, "state");
	const stat = await lstat(state);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("business_wake_state_invalid");
	const handle = await open(
		join(state, "business-wakes.json"),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const file = await handle.stat();
		if (!file.isFile() || file.size > 16384)
			throw new Error("business_wake_file_invalid");
		const buffer = Buffer.alloc(16385);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 16384) throw new Error("business_wake_file_too_large");
		const bytes = buffer.subarray(0, bytesRead);
		return {
			digest: createHash("sha256").update(bytes).digest("hex"),
			...parseBusinessWakeSchedule(bytes.toString("utf8")),
		};
	} finally {
		await handle.close();
	}
}
export interface BusinessWakePassDeps {
	projects: readonly (Pick<ProjectEntry, "projectName" | "projectRoot"> & {
		leads: readonly Pick<LeadConfig, "agentId" | "businessWakeFile">[];
	})[];
	store: Pick<
		StateStore,
		"appendLeadEvent" | "getLeadEventBySeq" | "listPendingBusinessWakeEvents"
	>;
	enqueueLeadEvent(envelope: LeadEventEnvelope): unknown;
	inspectDeliveryState(
		projectName: string,
		deliveryId: string,
	): MailboxSettlement;
	now?: () => number;
	founderTimezone?: () => string;
	readSchedule?: typeof readBusinessWakeFile;
	log?: (message: string) => void;
}
export function createBusinessWakePass(
	deps: BusinessWakePassDeps,
): () => Promise<void> {
	let active: Promise<void> | undefined;
	async function run() {
		const now = deps.now?.() ?? Date.now();
		const founderTimezone = (deps.founderTimezone ?? resolveFounderTimezone)();
		const attempted = new Set<number>();
		const enqueue = (row: LeadEventRow) => {
			if (attempted.has(row.seq)) return;
			attempted.add(row.seq);
			try {
				const envelope = leadEventEnvelopeFromJournalRow(row, 2);
				if (!envelope.event.project_name) throw new Error("missing project");
				if (
					deps.inspectDeliveryState(
						envelope.event.project_name,
						canonicalLeadEventDeliveryId(envelope),
					).kind === "absent_identity"
				)
					deps.enqueueLeadEvent(envelope);
			} catch {
				deps.log?.(
					`[business_wake] enqueue unavailable: ${row.lead_id}/${row.event_id}`,
				);
			}
		};
		for (const row of deps.store.listPendingBusinessWakeEvents()) enqueue(row);
		for (const project of deps.projects)
			for (const lead of project.leads) {
				if (!lead.businessWakeFile) continue;
				try {
					const read = deps.readSchedule ?? readBusinessWakeFile;
					const file = await read(project.projectRoot);
					const candidates = file.schedules
						.map((schedule) => ({
							schedule,
							due: latestBusinessWakeDue(schedule, now, founderTimezone),
						}))
						.filter((item) => item.due !== undefined);
					if (candidates.length === 0) continue;
					// A changed or deleted file is reconsidered on the next existing poll tick.
					if ((await read(project.projectRoot)).digest !== file.digest)
						continue;
					for (const { schedule, due } of candidates) {
						if (!due) continue;
						const eventId = `business-wake:${project.projectName}:${lead.agentId}:${schedule.id}:${due.localDate}`;
						const businessWake = {
							scheduleId: schedule.id,
							revision: schedule.revision,
							configDigest: file.digest,
							...due,
						};
						const seq = deps.store.appendLeadEvent(
							lead.agentId,
							eventId,
							"business_wake",
							JSON.stringify({
								event_type: "business_wake",
								execution_id: eventId,
								issue_id: "",
								project_name: project.projectName,
								status: "scheduled",
								business_wake: businessWake,
								summary: `Scheduled business wake: ${JSON.stringify(businessWake)}. Resume durable business work for this schedule.`,
								generated_at: new Date(now).toISOString(),
							}),
							"business-wake",
						);
						const row = deps.store.getLeadEventBySeq(seq);
						if (row) enqueue(row);
					}
				} catch {
					deps.log?.(
						`[business_wake] schedule unavailable: ${project.projectName}/${lead.agentId}`,
					);
				}
			}
	}
	return () => {
		if (!active)
			active = run().finally(() => {
				active = undefined;
			});
		return active;
	};
}
