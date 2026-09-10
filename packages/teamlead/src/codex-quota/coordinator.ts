import { createHash, randomUUID } from "node:crypto";
import type { CodexQuotaStore } from "../bridge/codex-quota-store.js";
import {
	type CodexQuotaObservation,
	selectCodexQuotaCandidate,
} from "./candidate-selector.js";

/** The successful recovery SLO is also the maximum silent quota pause. */
export const CODEX_QUOTA_MAX_PAUSE_MS = 10 * 60_000;
export interface CodexQuotaCoordinatorOptions {
	store: CodexQuotaStore;
	now?: () => number;
	autoEnabled?: () => boolean;
	reconcileInstallation?(
		incident: Record<string, unknown>,
		material: NonNullable<
			ReturnType<CodexQuotaStore["getInstallationMaterial"]>
		>,
	): Promise<"installed" | "rolled_back" | "uncertain">;
	readiness(rootKey: string): Promise<boolean>;
	observe(rootKey: string): Promise<CodexQuotaObservation[]>;
	rotate(
		incident: Record<string, unknown>,
		candidate: CodexQuotaObservation,
	): Promise<{ ok: boolean; authDigest?: string }>;
	recover(incident: Record<string, unknown>): Promise<void>;
}

export class CodexQuotaCoordinator {
	private inFlight: Promise<void> | undefined;
	constructor(private readonly options: CodexQuotaCoordinatorOptions) {}
	tick(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.run().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}
	private async run(): Promise<void> {
		if (this.options.autoEnabled?.() === false) return;
		const clock = this.options.now ?? Date.now;
		for (const incident of this.options.store.listIncidents()) {
			let now = clock();
			const id = String(incident.incident_id);
			const rootKey = String(incident.root_key);
			const pendingTargets = this.options.store
				.listTargets(id)
				.some(
					(target) =>
						!["recovered", "abandoned"].includes(String(target.state)),
				);
			// Attribute admission waits to the generation that paused them. A newer
			// root's waiter must not reopen or alert an unrelated settled incident.
			const pendingWaiters = this.options.store
				.listAdmissionWaits()
				.some(
					(waiter) =>
						waiter.root_key === rootKey &&
						Number(waiter.generation) === Number(incident.generation),
				);
			if (incident.state === "settled") {
				if (!pendingTargets && !pendingWaiters) continue;
				this.options.store.setIncidentState(id, "recovering");
				incident.state = "recovering";
			}
			try {
				if (
					now - Date.parse(String(incident.first_seen_at)) >=
						CODEX_QUOTA_MAX_PAUSE_MS &&
					(this.options.store.isPaused(rootKey) ||
						pendingTargets ||
						pendingWaiters)
				) {
					this.options.store.enqueueOutbox({
						incidentId: id,
						kind: "founder_alert",
						destination: "founder",
						payload: {
							vendor: "codex",
							reason: "quota_pause_expired",
							incidentId: id,
						},
					});
				}
				if (incident.state === "committed" || incident.state === "recovering") {
					await this.options.recover(incident);
					continue;
				}
				const root = this.options.store.getRoot(rootKey);
				if (!root || root.generation !== incident.generation) {
					// A delayed old-generation casualty must not pause or accuse the current root.
					// Recovery independently requires a current same-root committed probe permit.
					if (root && root.generation > Number(incident.generation))
						await this.options.recover(incident);
					continue;
				}
				if (
					this.options.store.isPaused(rootKey) &&
					now - Date.parse(String(incident.first_seen_at)) >=
						CODEX_QUOTA_MAX_PAUSE_MS
				) {
					this.options.store.enqueueOutbox({
						incidentId: id,
						kind: "founder_alert",
						destination: "founder",
						payload: {
							vendor: "codex",
							reason: "quota_pause_expired",
							incidentId: id,
						},
					});
				}
				if (
					incident.next_attempt_at &&
					Date.parse(String(incident.next_attempt_at)) > now
				)
					continue;
				if (!(await this.options.readiness(rootKey))) {
					this.options.store.setIncidentState(
						id,
						incident.state === "installing" ? "installing" : "retry_wait",
						"readiness_failed",
						new Date(now + 60_000).toISOString(),
					);
					continue;
				}
				if (incident.state === "installing") {
					const material = this.options.store.getInstallationMaterial(id);
					const outcome =
						material && this.options.reconcileInstallation
							? await this.options.reconcileInstallation(incident, material)
							: "uncertain";
					if (outcome === "installed" && material) {
						this.options.store.commitGeneration({
							incidentId: id,
							expectedGeneration: root.generation,
							profile: material.profile,
							accountKey: material.accountKey,
							authDigest: material.installedAuthDigest,
							probeResult: "ok",
							now: new Date(now).toISOString(),
						});
						await this.options.recover(this.options.store.getIncident(id)!);
					} else if (outcome === "rolled_back") {
						this.options.store.setIncidentState(
							id,
							"retry_wait",
							"installation_rolled_back",
							new Date(now + 60_000).toISOString(),
						);
					}
					continue;
				}
				const observations = await this.options.observe(rootKey);
				now = clock();
				const source = observations.find(
					(item) => item.accountKey === root.accountKey,
				);
				const limitedWindows =
					source?.windows.filter((window) => window.usedPercent === 100) ?? [];
				this.options.store.recordSourceReset(
					id,
					limitedWindows.length &&
						limitedWindows.every((window) => window.resetsAt !== null)
						? Math.max(...limitedWindows.map((window) => window.resetsAt!))
						: null,
				);
				const selected = selectCodexQuotaCandidate(observations, { now });
				if (selected.kind !== "selected" || !selected.candidate) {
					const exhausted = selected.kind === "pool_exhausted";
					this.options.store.setIncidentState(
						id,
						exhausted ? "pool_exhausted" : "retry_wait",
						selected.kind,
						new Date(selected.nextAttemptAt ?? now + 60_000).toISOString(),
					);
					this.options.store.enqueueOutbox({
						incidentId: id,
						kind: exhausted ? "founder_alert" : "lead_diagnostic",
						destination: exhausted ? "founder" : "lead",
						payload: {
							vendor: "codex",
							reason: selected.kind,
							incidentId: id,
							nextAttemptAt: selected.nextAttemptAt ?? now + 60_000,
						},
					});
					continue;
				}
				const { observedAt: _observedAt, ...evidence } = selected.candidate;
				const evidenceKey = createHash("sha256")
					.update(JSON.stringify(evidence))
					.digest("hex");
				if (!this.options.store.claimSelection(id, evidenceKey)) continue;
				const rotated = await this.options.rotate(incident, selected.candidate);
				if (!rotated.ok || !rotated.authDigest) {
					// A failed install can have renamed canonical already. Its durable journal
					// outranks the transport result; reconcile before any new selection/probe.
					if (this.options.store.getIncident(id)?.state === "installing") {
						this.options.store.setIncidentState(
							id,
							"installing",
							"installation_uncertain",
							new Date(clock() + 60_000).toISOString(),
						);
						continue;
					}

					this.options.store.recordSwitchAudit({
						switchId: randomUUID(),
						incidentId: id,
						from: root.profile,
						to: selected.candidate.profile,
						reason: "usage_limit",
						probeResult: "failed",
						at: new Date(now).toISOString(),
					});
					this.options.store.setIncidentState(
						id,
						"probe_failed",
						"probe_failed",
						new Date(now + 60_000).toISOString(),
					);
					this.options.store.enqueueOutbox({
						incidentId: id,
						kind: "lead_diagnostic",
						destination: "lead",
						payload: {
							vendor: "codex",
							reason: "probe_failed",
							incidentId: id,
						},
					});
					continue;
				}
				this.options.store.commitGeneration({
					incidentId: id,
					expectedGeneration: root.generation,
					accountKey: selected.candidate.accountKey,
					profile: selected.candidate.profile,
					authDigest: rotated.authDigest,
					probeResult: "ok",
					now: new Date(now).toISOString(),
				});
				await this.options.recover(this.options.store.getIncident(id)!);
			} catch {
				const current = this.options.store.getIncident(id);
				if (
					current &&
					!["committed", "recovering", "settled"].includes(
						String(current.state),
					)
				)
					this.options.store.setIncidentState(
						id,
						current.state === "installing" ? "installing" : "retry_wait",
						"coordinator_operation_failed",
						new Date(now + 60_000).toISOString(),
					);
				this.options.store.enqueueOutbox({
					incidentId: id,
					kind: "lead_diagnostic",
					destination: "lead",
					payload: {
						vendor: "codex",
						incidentId: id,
						reason: "coordinator_operation_failed",
					},
				});
			}
		}
	}
}
