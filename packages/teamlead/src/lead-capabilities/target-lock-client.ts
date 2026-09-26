import { z } from "zod";
import type { LeadCapabilityRuntimeAuthorityOptions } from "./runtime-authority.js";
import { resolveLeadCapabilityRuntimeAuthority } from "./runtime-authority.js";

export type LeadTargetLockAcquireStatus =
	| { status: "acquired"; fence: string }
	| {
			status:
				| "waiting"
				| "resident_lead_active_on_target"
				| "target_busy"
				| "target_pending_reconcile";
	  };
export interface LeadTargetLockClient {
	readonly actor: "resident" | "voice";
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
	const token = env.FLYWHEEL_API_TOKEN;
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
	async function call(
		action: "acquire" | "mark-dispatched" | "release" | "cancel",
		input: Record<string, unknown> & { requestId: string; signal: AbortSignal },
	) {
		const { signal, ...fields } = input;
		signal.throwIfAborted();
		trusted.assertActivationCurrent();
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
		trusted.assertActivationCurrent();
		return parsed;
	}
	return Object.freeze({
		actor: authority.kind === "voice_session" ? "voice" : "resident",
		acquire: async (input) => {
			const result = await call("acquire", input);
			if (result.status === "acquired" && result.fence)
				return { status: "acquired", fence: result.fence };
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
			await call("release", input);
		},
		cancel: async (input) => {
			await call("cancel", input);
		},
	});
}
