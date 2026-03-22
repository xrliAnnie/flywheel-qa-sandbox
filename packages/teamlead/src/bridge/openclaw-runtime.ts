/**
 * GEO-195: OpenClawRuntime — wraps existing notifyAgent() + buildHookBody()
 * into a LeadRuntime implementation. Behavior-preserving extraction.
 */

import {
	buildHookBody,
	notifyAgent,
} from "./hook-payload.js";
import type {
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

	async deliver(envelope: LeadEventEnvelope): Promise<void> {
		const body = buildHookBody(
			envelope.leadId,
			envelope.event,
			envelope.sessionKey,
		);
		await notifyAgent(this.gatewayUrl, this.hooksToken, body);
		this.lastDeliveryAt = new Date().toISOString();
		this.lastDeliveredSeq = envelope.seq;
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
