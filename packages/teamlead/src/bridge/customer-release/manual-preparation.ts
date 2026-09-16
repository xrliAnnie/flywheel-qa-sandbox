import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CustomerReleaseAuthority } from "./authority.js";
import { releaseCard, releaseMessageDigest } from "./cards.js";
import type { CustomerReleaseDispatch } from "./dispatch.js";
import type {
	ReleaseWorkflowBinding,
	ReleaseWorkflowRequest,
} from "./github.js";
import type { CustomerReleaseSource } from "./source.js";
import type { CustomerReleaseStore } from "./store.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ManualReleasePreparation {
	private last: { key: string; at: number } | null = null;
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			read: () => unknown;
			snapshot: () => ReturnType<CustomerReleaseAuthority["read"]>;
			source: Pick<CustomerReleaseSource, "manifest" | "prepared">;
			dispatch: Pick<CustomerReleaseDispatch, "tick">;
			workflow: ReleaseWorkflowBinding;
			now: () => number;
		},
	) {}
	async tick(signal?: AbortSignal): Promise<void> {
		try {
			const snapshot = structuredClone(this.options.snapshot()),
				input = structuredClone(this.options.read()),
				now = this.options.now(),
				store = this.options.store;
			if (
				!snapshot ||
				snapshot.config.mode === "observe" ||
				!input ||
				typeof input !== "object" ||
				Array.isArray(input)
			)
				return;
			const raw = input as Record<string, unknown>,
				keys = [
					"schemaVersion",
					"operation",
					"requestId",
					"cycleId",
					"releaseId",
					"epoch",
					"identityDigest",
					"requestedAt",
					"expiresAt",
					"sourceBindingDigest",
				];
			if (
				Object.keys(raw).length !== keys.length ||
				keys.some((key) => !Object.hasOwn(raw, key)) ||
				raw.schemaVersion !== 1 ||
				(raw.operation !== "prepare" && raw.operation !== "rebind") ||
				typeof raw.requestId !== "string" ||
				!/^[a-f0-9]{32}$/.test(raw.requestId) ||
				typeof raw.cycleId !== "string" ||
				typeof raw.releaseId !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(raw.releaseId) ||
				raw.epoch !== snapshot.target.epoch ||
				raw.identityDigest !== snapshot.identity.identityDigest ||
				!Number.isSafeInteger(raw.requestedAt) ||
				!Number.isSafeInteger(raw.expiresAt) ||
				(raw.requestedAt as number) > now ||
				(raw.requestedAt as number) < 0 ||
				(raw.expiresAt as number) <= now ||
				(raw.operation === "prepare" && raw.sourceBindingDigest !== null)
			)
				return;
			const cycle = store.get(raw.cycleId);
			if (
				!cycle ||
				cycle.projectId !== "flywheel" ||
				cycle.state !== "cancelled" ||
				cycle.releaseId === raw.releaseId ||
				store.unresolvedDecision("flywheel") ||
				store.manual.get(raw.requestId)
			)
				return;
			if (
				raw.operation === "rebind" &&
				(!cycle.binding || raw.sourceBindingDigest !== hash(cycle.binding))
			)
				return;
			const key = JSON.stringify(raw);
			if (
				this.last?.key === key &&
				now >= this.last.at &&
				now - this.last.at < 30000
			)
				return;
			this.last = { key, at: now };
			const ensure = () => {
				signal?.throwIfAborted();
				const current = this.options.snapshot(),
					saved = store.get(cycle.cycleId);
				if (
					!current ||
					current.config.mode === "observe" ||
					!isDeepStrictEqual(current.identity, snapshot.identity) ||
					!isDeepStrictEqual(current.target, snapshot.target) ||
					!isDeepStrictEqual(this.options.read(), input) ||
					!saved ||
					saved.revision !== cycle.revision ||
					saved.state !== "cancelled" ||
					this.options.now() >= (raw.expiresAt as number) ||
					store.unresolvedDecision("flywheel")
				)
					throw new Error("manual preparation changed");
			};
			ensure();
			const inputs: Record<string, string> = {
				mode: raw.operation,
				"release-id": raw.releaseId,
			};
			if (raw.operation === "prepare")
				inputs.beta = cycle.frozenBeta.betaVersion;
			else {
				inputs["source-release-id"] = cycle.releaseId;
				inputs["source-binding-digest"] = raw.sourceBindingDigest as string;
			}
			const request: ReleaseWorkflowRequest = {
				dispatchId: hash(["manual-prepare", raw.requestId]),
				createdAt: raw.requestedAt as number,
				inputs,
			};
			const result = await this.options.dispatch.tick(
				cycle.cycleId,
				this.options.workflow,
				request,
				signal,
			);
			ensure();
			if (result?.state !== "succeeded") return;
			const source = await this.options.source.manifest(signal);
			ensure();
			const proof = await this.options.source.prepared(
				source.manifest,
				raw.releaseId,
				cycle.frozenBeta,
				signal,
			);
			ensure();
			const card = {
				requestId: raw.requestId,
				activationEpoch: snapshot.target.epoch,
				policyRevision: snapshot.identity.policyRevision,
				releaseId: raw.releaseId,
				applicationId: snapshot.target.applicationId,
				channelId: snapshot.target.channelId,
				botUserId: snapshot.target.botUserId,
				founderId: snapshot.target.founderId,
				expiresAt: raw.expiresAt as number,
			};
			const rendered = releaseCard({
				kind: "go",
				nonce: card.requestId,
				epoch: card.activationEpoch,
				timezone: snapshot.config.timezone!,
				betaVersion: proof.binding.betaVersion,
				releaseVersion: proof.binding.releaseVersion,
				sourceCommit: proof.binding.sourceCommit,
				payloadSha256: proof.binding.releasePayloadSha256,
				deadlineAt: card.expiresAt,
			});
			store.manual.prepare(
				cycle.cycleId,
				source.manifest,
				{
					workflowRunId: String(result.runId),
					equivalenceVerified: true,
					readbackSha256: proof.readbackSha256,
				},
				{ ...card, messageDigest: releaseMessageDigest(rendered) },
				this.options.now(),
			);
		} catch {
			/* No go or permit can be synthesized from a failed preparation. */
		}
	}
}
