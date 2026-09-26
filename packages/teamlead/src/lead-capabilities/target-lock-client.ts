import { z } from "zod";
import { getLeadCapability } from "./catalog.js";
import type { LeadCapabilityRuntimeAuthorityOptions } from "./runtime-authority.js";
import { resolveLeadCapabilityRuntimeAuthority } from "./runtime-authority.js";

export type LeadTargetLockAcquireStatus =
	| { status: "acquired"; fence: string }
	| { status: "unguarded" }
	| {
			status:
				| "waiting"
				| "resident_lead_active_on_target"
				| "target_busy"
				| "target_pending_reconcile";
	  };
export interface LeadTargetLockClient {
	recordFounderDenial?(input: {
		operationId: string;
		requestId: string;
	}): Promise<string | undefined>;
	readonly actor: "resident" | "voice";
	/**
	 * False only for a resident Lead that never configured `voiceBackground`:
	 * that Lead keeps the pre-voice write path (no alias lookup, no lock RPC).
	 */
	participates?(): boolean;
	acquire(input: {
		operationId: string;
		requestId: string;
		targetKey: string;
		deadline: number;
		signal: AbortSignal;
	}): Promise<LeadTargetLockAcquireStatus>;
	markDispatched(input: {
		operationId: string;
		requestId: string;
		targetKey: string;
		fence: string;
		signal: AbortSignal;
	}): Promise<boolean>;
	release(input: {
		operationId: string;
		requestId: string;
		targetKey: string;
		fence: string;
		outcome: "succeeded" | "rejected" | "not_dispatched" | "unknown";
		reason?: string;
		providerRef?: string;
		signal: AbortSignal;
	}): Promise<void>;
	cancel(input: {
		operationId: string;
		requestId: string;
		targetKey: string;
		signal: AbortSignal;
	}): Promise<void>;
}

const reply = z
	.object({
		requestId: z.string().uuid(),
		status: z.string().min(1).max(64),
		fence: z.string().uuid().optional(),
	})
	.passthrough();
const denied = () => new Error("target_lock_unavailable");

export function createLeadTargetLockClient(
	options: {
		activationId: string;
		fetchImpl?: typeof fetch;
	} & LeadCapabilityRuntimeAuthorityOptions,
): LeadTargetLockClient {
	const env = Object.freeze({ ...options.env });
	const { authority, authoritySecret, trusted } =
		resolveLeadCapabilityRuntimeAuthority({ ...options, env });
	const token = env.FLYWHEEL_API_TOKEN ?? "";
	let origin: URL;
	try {
		origin = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
	} catch {
		throw denied();
	}
	if (
		!token ||
		token.length > 8192 ||
		/[\r\n]/.test(token) ||
		!options.activationId ||
		!["http:", "https:"].includes(origin.protocol) ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		(origin.protocol === "http:" &&
			!["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))
	)
		throw denied();
	const fetchImpl = options.fetchImpl ?? fetch;
	const common = {
		projectName: env.FLYWHEEL_PROJECT_NAME,
		leadId: env.FLYWHEEL_LEAD_ID,
		identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
		authority,
		activationId: options.activationId,
	};
	const settlementTickets = new Map<string, string>();
	const ticketKey = (input: Record<string, unknown>) =>
		JSON.stringify([input.operationId, input.requestId, input.targetKey]);
	async function call(
		action:
			| "policy"
			| "acquire"
			| "mark-dispatched"
			| "release"
			| "cancel"
			| "founder-denial",
		input: Record<string, unknown> & { requestId: string; signal: AbortSignal },
	) {
		const { signal, ...fields } = input;
		signal.throwIfAborted();
		const settlement =
			action === "release" &&
			settlementTickets.get(ticketKey(fields)) === fields.fence;
		if (action === "release" && !settlement) throw denied();
		if (!settlement) trusted.assertActivationCurrent();
		const response = await fetchImpl(
			new URL(`/api/lead-capabilities/target-lock/${action}`, origin),
			{
				method: "POST",
				redirect: "error",
				signal,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ ...common, ...fields }),
			},
		);
		if (!response.body || !response.ok) throw denied();
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192))
			throw denied();
		const text = await response.text();
		if (
			Buffer.byteLength(text) > 8192 ||
			text.includes(token) ||
			text.includes(authoritySecret)
		)
			throw denied();
		const parsed = reply.parse(JSON.parse(text));
		if (parsed.requestId !== input.requestId) throw denied();
		signal.throwIfAborted();
		if (!settlement) trusted.assertActivationCurrent();
		return parsed;
	}
	const backgroundOf = (row: { lead: unknown }) => {
		const background = (row.lead as { voiceBackground?: unknown })
			.voiceBackground;
		return {
			configured: background !== undefined && background !== null,
			enabled:
				background !== null &&
				typeof background === "object" &&
				"enabled" in background &&
				background.enabled === true,
		};
	};
	return Object.freeze<LeadTargetLockClient>({
		recordFounderDenial: async (input) => {
			if (
				authority.kind !== "voice_session" ||
				getLeadCapability(input.operationId)?.classification !== "reserved"
			)
				throw denied();
			const result = await call("founder-denial", {
				...input,
				targetKey: `${env.FLYWHEEL_PROJECT_NAME}:founder-only:${input.operationId}`,
				signal: AbortSignal.timeout(2000),
			});
			if (
				result.status !== "recorded" ||
				typeof result.receiptId !== "string" ||
				!/^lead-event:[1-9][0-9]*$/.test(result.receiptId)
			)
				throw denied();
			return result.receiptId;
		},
		actor: authority.kind === "voice_session" ? "voice" : "resident",
		participates: () =>
			authority.kind === "voice_session" ||
			backgroundOf(trusted.assertActivationCurrent()).configured,
		acquire: async (input) => {
			input.signal.throwIfAborted();
			const { configured, enabled } = backgroundOf(
				trusted.assertActivationCurrent(),
			);
			if (authority.kind === "carrier" && !enabled) {
				if (!configured) return { status: "unguarded" };
				// Never cached: draining can begin after any enable→disable cycle.
				const policy = await call("policy", input);
				if (policy.status === "disabled") return { status: "unguarded" };
				if (policy.status !== "draining") throw denied();
			}
			const result = await call("acquire", input);
			if (result.status === "unguarded" && authority.kind === "carrier")
				return { status: "unguarded" };
			if (result.status === "acquired" && result.fence) {
				settlementTickets.set(ticketKey(input), result.fence);
				return { status: "acquired", fence: result.fence };
			}
			if (
				[
					"waiting",
					"resident_lead_active_on_target",
					"target_busy",
					"target_pending_reconcile",
				].includes(result.status)
			)
				return { status: result.status } as LeadTargetLockAcquireStatus;
			throw denied();
		},
		markDispatched: async (input) =>
			(await call("mark-dispatched", input)).status === "marked",
		release: async (input) => {
			const result = await call("release", input);
			if (result.status === "released" || result.status === "not_owner")
				settlementTickets.delete(ticketKey(input));
		},
		cancel: async (input) => {
			await call("cancel", input);
		},
	});
}
