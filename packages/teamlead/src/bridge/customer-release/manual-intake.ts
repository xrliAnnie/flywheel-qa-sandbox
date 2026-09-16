import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CustomerReleaseAuthority } from "./authority.js";
import { customerReleaseSchedule } from "./scheduler.js";
import { type CustomerReleaseSource, selectCustomerBeta } from "./source.js";
import type { CustomerReleaseStore } from "./store.js";

const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ManualReleaseIntake {
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			read: () => unknown;
			snapshot: () => ReturnType<CustomerReleaseAuthority["read"]>;
			source: Pick<CustomerReleaseSource, "manifest">;
			localDeployedSha: () => string | null;
			now: () => number;
		},
	) {}
	private current() {
		const snapshot = structuredClone(this.options.snapshot()),
			raw = structuredClone(this.options.read()),
			now = this.options.now();
		if (
			!snapshot ||
			snapshot.config.mode === "observe" ||
			!raw ||
			typeof raw !== "object" ||
			Array.isArray(raw)
		)
			return null;
		const value = raw as Record<string, unknown>;
		const keys = [
			"schemaVersion",
			"requestId",
			"betaVersion",
			"slotDate",
			"releaseId",
			"epoch",
			"identityDigest",
			"requestedAt",
			"expiresAt",
		];
		if (
			Object.keys(value).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(value, key)) ||
			value.schemaVersion !== 1 ||
			typeof value.requestId !== "string" ||
			!/^[a-f0-9]{32}$/.test(value.requestId) ||
			typeof value.betaVersion !== "string" ||
			typeof value.slotDate !== "string" ||
			typeof value.releaseId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.releaseId) ||
			value.epoch !== snapshot.target.epoch ||
			value.identityDigest !== snapshot.identity.identityDigest ||
			!Number.isSafeInteger(value.requestedAt) ||
			!Number.isSafeInteger(value.expiresAt) ||
			(value.requestedAt as number) < 0 ||
			(value.requestedAt as number) > now ||
			(value.expiresAt as number) <= now
		)
			return null;
		const schedule = customerReleaseSchedule(
			snapshot.config as Parameters<typeof customerReleaseSchedule>[0],
			now,
		);
		if (schedule.kind !== "scheduled" || value.slotDate !== schedule.slotDate)
			return null;
		const parentReleaseId = `manual-intake-${value.requestId}`;
		if (value.releaseId === parentReleaseId) return null;
		return {
			snapshot,
			value,
			schedule,
			parentReleaseId,
			requestDigest: digest(value),
		};
	}
	preparedRequest(): unknown | null {
		try {
			const current = this.current();
			if (!current) return null;
			const cycle = this.options.store.forWeek(
				"flywheel",
				current.schedule.weekStart,
			);
			if (
				!cycle ||
				this.options.store.manualIntakeDigest(cycle.cycleId) !==
					current.requestDigest
			)
				return null;
			const raw = current.value;
			return {
				schemaVersion: 1,
				operation: "prepare",
				requestId: raw.requestId,
				cycleId: cycle.cycleId,
				releaseId: raw.releaseId,
				epoch: raw.epoch,
				identityDigest: raw.identityDigest,
				requestedAt: raw.requestedAt,
				expiresAt: raw.expiresAt,
				sourceBindingDigest: null,
			};
		} catch {
			return null;
		}
	}
	async tick(signal?: AbortSignal): Promise<void> {
		try {
			const current = this.current();
			if (!current || this.options.store.unresolvedDecision("flywheel")) return;
			if (this.options.store.forWeek("flywheel", current.schedule.weekStart))
				return;
			const deployed = this.options.localDeployedSha(),
				source = await this.options.source.manifest(signal);
			signal?.throwIfAborted();
			const after = this.current();
			if (
				!after ||
				!isDeepStrictEqual(after, current) ||
				deployed !== this.options.localDeployedSha()
			)
				return;
			const candidate = selectCustomerBeta(source.manifest, deployed);
			if (!candidate || candidate.betaVersion !== current.value.betaVersion)
				return;
			this.options.store.reserveManualIntake(
				{
					projectId: "flywheel",
					slotDate: current.schedule.slotDate,
					releaseId: current.parentReleaseId,
					activationEpoch: current.snapshot.target.epoch,
					policyRevision: current.snapshot.identity.policyRevision,
					betaVersion: candidate.betaVersion,
					manifest: source.manifest,
					now: this.options.now(),
				},
				current.requestDigest,
			);
		} catch {
			/* No slot or authority is synthesized from unknown source evidence. */
		}
	}
}
