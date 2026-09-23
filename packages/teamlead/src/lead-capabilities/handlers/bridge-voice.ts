import { z } from "zod";
import type {
	HandlerOutcome,
	LeadOperationContext,
	LeadOperationHandler,
} from "../broker.js";
import { OperationRequestSchema } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

const OPERATIONS = [
	"voice.session.start",
	"voice.session.status",
	"voice.session.stop",
] as const;
const replySchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "rejected", "unknown"]),
		// FLY-2701: a start deduplicated into an existing booking refers to that
		// booking, not to a session. Both shapes stay tightly pinned.
		resourceRefs: z
			.array(z.string().regex(/^voice-(?:session|schedule):[0-9a-f-]{36}$/))
			.max(1),
		data: z.unknown().optional(),
		errorCode: z
			.string()
			.regex(/^[a-z0-9_]{1,128}$/)
			.optional(),
	})
	.strict();
const denied = () => new Error("bridge_voice_scope_denied");

export function createBridgeVoiceHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	fetchImpl?: typeof fetch;
	secrets?: readonly string[];
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env });
	const activationId = options.activationId;
	const token = env.FLYWHEEL_API_TOKEN;
	const claim = env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	let trusted: ReturnType<typeof createLeadCapabilityContext>;
	let baseUrl: URL;
	try {
		trusted = createLeadCapabilityContext(env);
		baseUrl = new URL(env.FLYWHEEL_BRIDGE_URL ?? "");
		if (
			!token ||
			!claim ||
			/\r|\n/u.test(token) ||
			token.length > 8_192 ||
			claim.length > 256 ||
			!activationId ||
			activationId.length > 128 ||
			!(["http:", "https:"] as const).includes(
				baseUrl.protocol as "http:" | "https:",
			) ||
			baseUrl.username ||
			baseUrl.password ||
			baseUrl.search ||
			baseUrl.hash ||
			baseUrl.pathname !== "/" ||
			(baseUrl.protocol === "http:" &&
				!["127.0.0.1", "[::1]", "localhost"].includes(baseUrl.hostname))
		)
			throw denied();
	} catch {
		throw denied();
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const secrets = [token, claim, ...(options.secrets ?? [])].filter(
		(value): value is string => Boolean(value),
	);

	async function current(context: LeadOperationContext) {
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== activationId ||
			context.signal.aborted
		)
			throw denied();
		await context.assertCurrent();
		const row = trusted.assertActivationCurrent();
		if (row.lead.codexVoiceActions !== true) throw denied();
	}

	const handlers = new Map<string, LeadOperationHandler>();
	for (const operationId of OPERATIONS) {
		const definition = getLeadCapability(operationId)!;
		const envelope = (
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		) => {
			if (
				!OperationRequestSchema.safeParse({
					schemaVersion: 1,
					operationId,
					requestId: context.requestId,
					input: raw,
				}).success
			)
				throw denied();
			const input = definition.inputSchema.parse(raw);
			if (secrets.some((secret) => JSON.stringify(input).includes(secret)))
				throw denied();
			return JSON.stringify({
				schemaVersion: 1,
				operationId,
				requestId: context.requestId,
				projectName: env.FLYWHEEL_PROJECT_NAME,
				leadId: env.FLYWHEEL_LEAD_ID,
				identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
				carrierClaim: claim,
				activationId,
				input,
			});
		};
		const call = async (
			path: "" | "/receipt",
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		): Promise<HandlerOutcome> => {
			const body = envelope(raw, context);
			await current(context);
			const signal = AbortSignal.any([
				context.signal,
				AbortSignal.timeout(15_000),
			]);
			const response = await fetchImpl(
				new URL(
					path === ""
						? "/api/lead-capabilities/voice"
						: "/api/lead-capabilities/voice-receipt",
					baseUrl,
				),
				{
					method: "POST",
					redirect: "error",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body,
					signal,
				},
			);
			await current({ ...context, signal });
			if (response.status >= 300 && response.status < 400) throw denied();
			const length = response.headers.get("content-length");
			if (length && (!/^\d+$/u.test(length) || Number(length) > 65_536))
				throw denied();
			const text = await response.text();
			if (
				Buffer.byteLength(text) > 65_536 ||
				secrets.some((secret) => text.includes(secret))
			)
				throw denied();
			await current({ ...context, signal });
			const parsed = replySchema.safeParse(JSON.parse(text));
			if (!parsed.success || parsed.data.requestId !== context.requestId)
				throw denied();
			const reply = parsed.data;
			if (reply.status !== "succeeded") {
				// FLY-2701 review R4: a start refused because it disagreed with an
				// existing booking must name that booking, or the Lead is told
				// "rejected" with nothing to act on. The ref is the same pinned
				// shape the reply schema already validates.
				const conflictRef =
					operationId === "voice.session.start" &&
					reply.errorCode === "voice_schedule_binding_conflict" &&
					reply.resourceRefs[0]?.startsWith("voice-schedule:")
						? reply.resourceRefs[0]
						: undefined;
				return {
					status: reply.status,
					...(reply.errorCode ? { errorCode: reply.errorCode } : {}),
					...(conflictRef ? { providerRef: conflictRef } : {}),
				};
			}
			if (!response.ok || reply.resourceRefs.length !== 1) throw denied();
			const data = definition.outputSchema.parse(reply.data);
			if (data.receiptId !== context.requestId) throw denied();
			const result = data.result as Record<string, unknown>;
			// FLY-2701: a start for an already booked meeting is deduplicated into
			// that booking. It carries the booking's identity, not a session's, so
			// it is matched against its own resource ref.
			if (result.status === "schedule_bound") {
				const scheduleId = result.scheduleId;
				if (
					operationId !== "voice.session.start" ||
					typeof scheduleId !== "string" ||
					reply.resourceRefs[0] !== `voice-schedule:${scheduleId}`
				)
					throw denied();
				return {
					status: "succeeded",
					providerRef: reply.resourceRefs[0],
					data,
				};
			}
			const sessionId = result.sessionId;
			if (
				typeof sessionId !== "string" ||
				reply.resourceRefs[0] !== `voice-session:${sessionId}` ||
				(operationId !== "voice.session.start" &&
					sessionId !== raw.sessionId) ||
				(operationId === "voice.session.start" && result.mode !== raw.mode)
			)
				throw denied();
			return {
				status: "succeeded",
				providerRef: reply.resourceRefs[0],
				data,
			};
		};
		handlers.set(operationId, {
			authorize: async (raw, context) => {
				envelope(raw, context);
				await current(context);
			},
			execute: (raw, context) => call("", raw, context),
			...(operationId === "voice.session.status"
				? {}
				: {
						reconcile: (_receipt, raw, context) =>
							call("/receipt", raw, context),
					}),
		});
	}
	return handlers;
}
