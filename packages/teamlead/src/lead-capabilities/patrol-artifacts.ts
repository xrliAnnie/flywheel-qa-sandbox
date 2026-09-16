import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeadArtifactHandle, LeadArtifactStore } from "./artifacts.js";

const snapshot = z
	.object({
		path: z.string().max(4096),
		text: z.string().max(1024 * 1024),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		steps: z
			.array(
				z
					.object({
						step: z.number().int().min(1).max(6),
						status: z.enum(["healthy", "unhealthy", "unknown"]),
					})
					.strict(),
			)
			.length(6),
		evidenceHandle: z.string(),
		observedAt: z.string().datetime(),
	})
	.strict();
const denied = () => new Error("patrol_artifact_unverified");
/** Activation-local artifact association; Bridge remains the authority for every operation. */
export class PatrolArtifactProjection {
	private readonly records = new Map<
		string,
		{
			view: LeadArtifactHandle;
			bridgeEvidence: string;
			tickId: string;
			requestId: string;
		}
	>();
	constructor(
		private readonly store: LeadArtifactStore,
		private readonly secrets: readonly string[],
	) {}
	async accept(
		raw: unknown,
		requestId: string,
		tickId: string,
		refs: readonly string[],
	) {
		const data = snapshot.parse(raw);
		if (
			this.secrets.some(
				(secret) => secret.length > 0 && data.text.includes(secret),
			)
		)
			throw denied();
		const hash = createHash("sha256").update(data.text).digest("hex");
		const filename = data.path.split("/").at(-1)!;
		if (
			!/^(?:NA|[0-9]{1,16})$/.test(tickId) ||
			!new RegExp(`^[0-9]{8}T[0-9]{6}Z-tick${tickId}\\.md$`).test(filename) ||
			hash !== data.sha256 ||
			data.evidenceHandle !== `patrol_${requestId}` ||
			refs.length !== 1 ||
			refs[0] !== `patrol:${filename}:${hash}` ||
			data.steps.some((step, i) => step.step !== i + 1)
		)
			throw denied();
		let record = [...this.records.values()].find(
			(r) => r.requestId === requestId,
		);
		if (record) {
			if (record.tickId !== tickId || record.view.sha256 !== hash)
				throw denied();
			await this.store.read(record.view.handle);
		} else {
			const view = await this.store.put(Buffer.from(data.text), "text/plain");
			record = { view, bridgeEvidence: data.evidenceHandle, tickId, requestId };
			this.records.set(view.handle, record);
		}
		return {
			artifactHandle: record.view.handle,
			artifactPath: record.view.relativePath,
			steps: data.steps.map((step) => ({
				...step,
				evidenceHandle: record.view.handle,
			})),
			receiptId: requestId,
			observedAt: data.observedAt,
		};
	}
	async input(raw: Record<string, unknown>) {
		const record = this.records.get(raw.evidenceHandle as string);
		if (!record || record.tickId !== raw.tickId) throw denied();
		await this.store.read(record.view.handle);
		return { ...raw, evidenceHandle: record.bridgeEvidence };
	}
}
