import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type CustomerReleaseConfig,
	parseCustomerReleaseConfig,
} from "flywheel-config";
import { releaseCard, releaseMessageDigest } from "./cards.js";
import type { CustomerReleaseNoticeDelivery } from "./delivery.js";
import type { CustomerReleaseDispatch } from "./dispatch.js";
import type {
	ReleaseWorkflowBinding,
	ReleaseWorkflowObservation,
	ReleaseWorkflowRequest,
} from "./github.js";
import { customerReleaseSchedule } from "./scheduler.js";
import { type CustomerReleaseSource, selectCustomerBeta } from "./source.js";
import type { CustomerReleaseStore } from "./store.js";
import type { CustomerReleaseCycle } from "./types.js";

export interface CustomerAdvanceContext {
	config: CustomerReleaseConfig;
	founderId: string;
	flagEnabled: boolean;
	prepareWorkflow: ReleaseWorkflowBinding;
	executorWorkflow: ReleaseWorkflowBinding;
}
interface Options {
	store: CustomerReleaseStore;
	source: Pick<CustomerReleaseSource, "manifest" | "prepared">;
	dispatch: Pick<CustomerReleaseDispatch, "tick">;
	delivery: Pick<CustomerReleaseNoticeDelivery, "deliver" | "probe">;
	readiness: {
		evaluate: (
			subject: { sourceCommit: string; baseVersion: string },
			at: string,
		) => { verdictId: string; state: string };
	};
	context: () => CustomerAdvanceContext;
	localDeployedSha: () => string | null;
	now: () => number;
}
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Composes the approved automatic cycle. The decision pump alone may claim a
 * permit; this path prepares artifacts/notices/executors and never publishes. */
export class CustomerReleaseAdvance {
	private checkedAt: number | null = null;
	private checkedCycle: string | null = null;
	private lastProbe: { cycleId: string; at: number } | null = null;
	private lastWorkflow: {
		id: string;
		at: number;
		result: ReleaseWorkflowObservation | null;
	} | null = null;
	private probeDue(cycleId: string) {
		const now = this.options.now();
		return (
			!this.lastProbe ||
			this.lastProbe.cycleId !== cycleId ||
			now < this.lastProbe.at ||
			now - this.lastProbe.at >= 30000
		);
	}
	private async workflow(
		cycleId: string,
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
		signal?: AbortSignal,
	) {
		const now = this.options.now(),
			last = this.lastWorkflow;
		if (
			last?.id === request.dispatchId &&
			now >= last.at &&
			now - last.at < 30000
		)
			return last.result;
		const result = await this.options.dispatch.tick(
			cycleId,
			binding,
			request,
			signal,
		);
		this.lastWorkflow = { id: request.dispatchId, at: now, result };
		return result;
	}
	constructor(private readonly options: Options) {}
	private context() {
		const value = structuredClone(this.options.context());
		value.config = parseCustomerReleaseConfig(value.config);
		return value;
	}
	private enabled(context: CustomerAdvanceContext) {
		const state = this.options.store.activation.get(),
			config = context.config;
		return (
			config.mode === "canary" &&
			context.flagEnabled === true &&
			state?.enabled === true &&
			state.identity.founderId === context.founderId &&
			state.identity.policyRevision === config.policyRevision &&
			typeof config.founderEnableReceiptId === "string" &&
			config.founderEnableReceiptId.length > 0 &&
			state.enableReceiptId === config.founderEnableReceiptId &&
			!!state.evidenceBundleDigest
		);
	}
	private ensure(
		context: CustomerAdvanceContext,
		cycle?: CustomerReleaseCycle,
		signal?: AbortSignal,
	) {
		signal?.throwIfAborted();
		if (!isDeepStrictEqual(context, this.context()) || !this.enabled(context))
			throw new Error("release authority changed");
		if (cycle) {
			const state = this.options.store.activation.get(),
				current = this.options.store.get(cycle.cycleId);
			if (
				!current ||
				current.revision !== cycle.revision ||
				current.invalidatedEventSeq !== null ||
				current.activationEpoch !== state?.epoch ||
				current.policyRevision !== context.config.policyRevision ||
				this.options.localDeployedSha() !== cycle.frozenBeta.sourceCommit
			)
				throw new Error("release cycle changed");
		}
	}
	private cancel(cycle: CustomerReleaseCycle, reason: string) {
		const current = this.options.store.get(cycle.cycleId);
		if (current)
			this.options.store.invalidate(
				current.cycleId,
				current.revision,
				reason,
				this.options.now(),
			);
	}
	private evaluate(cycle: CustomerReleaseCycle) {
		const now = this.options.now();
		const result = this.options.readiness.evaluate(
			{
				sourceCommit: cycle.frozenBeta.sourceCommit,
				baseVersion: cycle.frozenBeta.baseVersion,
			},
			new Date(now).toISOString(),
		);
		this.checkedAt = now;
		this.checkedCycle = cycle.cycleId;
		if (result.state !== "green")
			this.cancel(
				cycle,
				`readiness_${result.state === "hold" ? "hold" : "unknown"}`,
			);
		return result.verdictId;
	}
	async tick(signal?: AbortSignal): Promise<void> {
		const store = this.options.store;
		try {
			const context = this.context(),
				config = context.config,
				now = this.options.now();
			if (config.mode !== "canary" || !this.enabled(context)) {
				store.invalidateRuntime("automatic_release_disabled", now, "automatic");
				return;
			}
			if (store.unresolvedDecision("flywheel")) return;
			const schedule = customerReleaseSchedule(config, now);
			if (schedule.kind !== "scheduled")
				throw new Error("release schedule invalid");
			const local = new Intl.DateTimeFormat("en-CA", {
				timeZone: config.timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).formatToParts(now);
			const date = ["year", "month", "day"]
				.map((key) => local.find((part) => part.type === key)?.value)
				.join("-");
			let cycle = store.forWeek("flywheel", schedule.weekStart);
			if (!cycle) {
				if (
					date < schedule.slotDate ||
					now < schedule.noticeAt ||
					store.activation.missedSlot(schedule.weekStart)
				)
					return;
				let snapshot: Awaited<ReturnType<CustomerReleaseSource["manifest"]>>;
				try {
					snapshot = await this.options.source.manifest(signal);
				} catch {
					store.activation.recordMissedSlot(
						schedule.weekStart,
						"unknown",
						this.options.now(),
					);
					throw new Error("release source unknown");
				}
				this.ensure(context, undefined, signal);

				let beta: ReturnType<typeof selectCustomerBeta>;
				try {
					beta = selectCustomerBeta(
						snapshot.manifest,
						this.options.localDeployedSha(),
					);
				} catch {
					store.activation.recordMissedSlot(
						schedule.weekStart,
						"unknown",
						this.options.now(),
					);
					return;
				}
				if (!beta) {
					store.activation.recordMissedSlot(
						schedule.weekStart,
						"no_candidate",
						this.options.now(),
					);
					return;
				}
				cycle = store.reserve({
					projectId: "flywheel",
					slotDate: schedule.slotDate,
					releaseId: `cr-${digest(["flywheel", schedule.weekStart]).slice(0, 40)}`,
					activationEpoch: store.activation.get()!.epoch,
					policyRevision: config.policyRevision,
					betaVersion: beta.betaVersion,
					manifest: snapshot.manifest,
					now: this.options.now(),
				});
			}
			if (
				[
					"cancelled",
					"published",
					"manual_ready",
					"committing",
					"commit_unknown",
				].includes(cycle.state)
			)
				return;
			this.ensure(context, cycle, signal);
			if (this.options.now() > schedule.claimNotAfter) {
				this.cancel(cycle, "claim_deadline_missed");
				return;
			}
			if (
				["evaluating", "preparing", "notice_pending"].includes(cycle.state) &&
				schedule.deadlineAt - this.options.now() <
					config.minimum_veto_minutes * 60000
			) {
				this.cancel(cycle, "notice_late");
				return;
			}
			if (cycle.state === "evaluating") {
				store.beginPreparation(
					cycle.cycleId,
					cycle.revision,
					this.options.now(),
					() => this.evaluate(cycle!),
				);
				cycle = store.get(cycle.cycleId)!;
				if (cycle.state !== "preparing") return;
			}
			if (
				this.checkedCycle !== cycle.cycleId ||
				this.checkedAt === null ||
				this.options.now() - this.checkedAt >= 30000
			) {
				this.evaluate(cycle);
				cycle = store.get(cycle.cycleId)!;
				if (cycle.state === "cancelled") return;
			}
			if (cycle.state === "preparing") {
				const run = await this.workflow(
					cycle.cycleId,
					context.prepareWorkflow,
					{
						dispatchId: digest([cycle.cycleId, "prepare"]),
						createdAt: cycle.createdAt,
						inputs: {
							mode: "prepare",
							"release-id": cycle.releaseId,
							beta: cycle.frozenBeta.betaVersion,
						},
					},
					signal,
				);
				this.ensure(context, cycle, signal);
				if (!run || run.state === "pending") return;
				if (run.state !== "succeeded") {
					this.cancel(cycle, "prepare_workflow_failed");
					return;
				}
				const snapshot = await this.options.source.manifest(signal);
				this.ensure(context, cycle, signal);
				const artifact = await this.options.source.prepared(
					snapshot.manifest,
					cycle.releaseId,
					cycle.frozenBeta,
					signal,
				);
				this.ensure(context, cycle, signal);
				const noticeId = randomBytes(16).toString("hex");
				const card = releaseCard({
					kind: "veto",
					nonce: noticeId,
					epoch: cycle.activationEpoch,
					timezone: config.timezone,
					betaVersion: cycle.frozenBeta.betaVersion,
					releaseVersion: artifact.binding.releaseVersion,
					sourceCommit: artifact.binding.sourceCommit,
					payloadSha256: artifact.binding.releasePayloadSha256,
					deadlineAt: schedule.deadlineAt,
				});
				this.ensure(context, cycle, signal);
				store.completePreparation(
					cycle.cycleId,
					cycle.revision,
					snapshot.manifest,
					{
						workflowRunId: String(run.runId),
						equivalenceVerified: true,
						readbackSha256: artifact.readbackSha256,
					},
					{
						noticeId,
						messageDigest: releaseMessageDigest(card),
						channelId: config.channelId,
						applicationId: config.applicationId,
						botUserId: config.botUserId,
						founderId: context.founderId,
						noticeAt: schedule.noticeAt,
						deadlineAt: schedule.deadlineAt,
						claimNotAfter: schedule.claimNotAfter,
						minimumVetoMinutes: config.minimum_veto_minutes,
					},
					this.options.now(),
				);
				cycle = store.get(cycle.cycleId)!;
			}
			if (cycle.state === "notice_pending") {
				const notice = store.notice(cycle.cycleId);
				if (!notice || !cycle.binding)
					throw new Error("release notice missing");
				this.ensure(context, cycle, signal);
				const delivered = await this.options.delivery.deliver(
					cycle.cycleId,
					releaseCard({
						kind: "veto",
						nonce: notice.noticeId,
						epoch: cycle.activationEpoch,
						timezone: config.timezone,
						betaVersion: cycle.binding.betaVersion,
						releaseVersion: cycle.binding.releaseVersion,
						sourceCommit: cycle.binding.sourceCommit,
						payloadSha256: cycle.binding.releasePayloadSha256,
						deadlineAt: notice.deadlineAt,
					}),
					signal,
				);
				if (delivered)
					this.lastProbe = { cycleId: cycle.cycleId, at: delivered.verifiedAt };
				cycle = store.get(cycle.cycleId)!;
			}
			if (cycle.state === "window_open") {
				if (
					this.options.now() < cycle.deadlineAt! &&
					!this.probeDue(cycle.cycleId)
				)
					return;
				const receipt = await this.options.delivery.probe(
					cycle.cycleId,
					signal,
				);
				if (!receipt) return;
				this.lastProbe = { cycleId: cycle.cycleId, at: receipt.verifiedAt };
				this.ensure(context, cycle, signal);
				if (this.options.now() < cycle.deadlineAt!) return;
				store.awaitAttempt(
					cycle.cycleId,
					cycle.revision,
					receipt,
					this.options.now(),
					() => this.evaluate(cycle!),
				);
				cycle = store.get(cycle.cycleId)!;
			}
			if (cycle.state === "awaiting_attempt") {
				if (this.probeDue(cycle.cycleId)) {
					const receipt = await this.options.delivery.probe(
						cycle.cycleId,
						signal,
					);
					if (!receipt) return;
					this.lastProbe = { cycleId: cycle.cycleId, at: receipt.verifiedAt };
				}
				this.ensure(context, cycle, signal);
				if (!cycle.binding) throw new Error("release binding missing");
				const result = await this.workflow(
					cycle.cycleId,
					context.executorWorkflow,
					{
						dispatchId: digest([cycle.cycleId, "execute", cycle.revision]),
						createdAt: cycle.createdAt,
						inputs: {
							operation: "execute",
							"cycle-id": cycle.cycleId,
							"release-id": cycle.releaseId,
							"binding-digest": digest(cycle.binding),
						},
					},
					signal,
				);
				this.ensure(context, cycle, signal);
				if (result?.state === "failed")
					this.cancel(cycle, "executor_workflow_failed");
			}
		} catch {
			store.invalidateRuntime(
				"automatic_advance_failed",
				this.options.now(),
				"automatic",
			);
		}
	}
}
