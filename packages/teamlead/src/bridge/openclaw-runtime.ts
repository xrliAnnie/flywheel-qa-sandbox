/**
 * GEO-195: OpenClawRuntime — wraps existing notifyAgent() + buildHookBody()
 * into a LeadRuntime implementation. Behavior-preserving extraction.
 */

import { buildHookBody } from "./hook-payload.js";
import type {
	DeliveryResult,
	LeadBootstrap,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "./lead-runtime.js";

export class OpenClawRuntime implements LeadRuntime {
	readonly type = "openclaw" as const;
	private lastDeliveryAt: string | null = null;
	private lastDeliveredSeq = 0;

	constructor(
		private gatewayUrl: string,
		private hooksToken: string,
	) {}

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		const body = buildHookBody(
			envelope.leadId,
			envelope.event,
			envelope.sessionKey,
		);
		// notifyAgent() swallows errors internally (best-effort design).
		// To get result-based delivery, we must do our own fetch with throwOnError.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			const res = await fetch(`${this.gatewayUrl}/hooks/ingest`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.hooksToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				return {
					delivered: false,
					error: `Gateway returned ${res.status}: ${text.slice(0, 200)}`,
				};
			}
			this.lastDeliveryAt = new Date().toISOString();
			this.lastDeliveredSeq = envelope.seq;
			return { delivered: true };
		} catch (err) {
			const error = (err as Error).message;
			console.warn(
				`[openclaw] Delivery failed for seq=${envelope.seq}:`,
				error,
			);
			return { delivered: false, error };
		} finally {
			clearTimeout(timeout);
		}
	}

	async sendBootstrap(_snapshot: LeadBootstrap): Promise<void> {
		// OpenClaw maintains its own persistent session — no bootstrap needed.
	}

	async health(): Promise<LeadRuntimeHealth> {
		return {
			status: this.lastDeliveryAt ? "healthy" : "degraded",
			lastDeliveryAt: this.lastDeliveryAt,
			lastDeliveredSeq: this.lastDeliveredSeq,
		};
	}

	async shutdown(): Promise<void> {
		// No-op — OpenClaw gateway lifecycle is external.
	}
}
