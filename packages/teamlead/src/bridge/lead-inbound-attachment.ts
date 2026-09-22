import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import {
	DiscordInboundAttachmentError,
	type DiscordInboundAttachmentFailureReason,
	fetchInboundDiscordAttachment,
} from "../lead-capabilities/discord-attachments.js";
import {
	captureInboundAttachmentScope,
	type InboundAttachmentScope,
	type InboundAttachmentScopeOptions,
} from "./inbound-attachment-scope.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_GLOBAL_ACTIVE = 32;
const MAX_CARRIER_ACTIVE = 2;

const requestSchema = z
	.object({
		schemaVersion: z.literal(1),
		mode: z.enum(["read", "validate"]),
		requestId: z.string().uuid(),
		projectName: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		leadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		deliveryId: z.string().min(1).max(256),
		attachmentId: z.string().regex(/^\d{17,20}$/),
		receiptDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if ((value.mode === "validate") !== (value.receiptDigest !== undefined)) {
			context.addIssue({
				code: "custom",
				message: "receiptDigest is required only for validate mode",
			});
		}
	});

export type InboundAttachmentScopeFactory = (
	options: InboundAttachmentScopeOptions,
) => Promise<InboundAttachmentScope>;

export interface LeadInboundAttachmentRouterOptions {
	apiToken: string;
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	commDbPath?: (projectName: string) => string;
	captureScope?: InboundAttachmentScopeFactory;
	fetchAttachment?: typeof fetchInboundDiscordAttachment;
	fetchImpl?: typeof fetch;
}

function failure(reason: DiscordInboundAttachmentFailureReason) {
	return new DiscordInboundAttachmentError(reason);
}

function failureStatus(reason: DiscordInboundAttachmentFailureReason): number {
	switch (reason) {
		case "scope_denied":
		case "carrier_expired":
			return 403;
		case "not_found":
			return 404;
		case "timeout":
			return 408;
		case "too_large":
			return 413;
		case "unsupported_type":
			return 415;
		case "producer_identity_missing":
		case "invalid_metadata":
		case "invalid_content":
			return 422;
		case "fetch_unavailable":
		case "transport_unavailable":
		case "busy":
			return 503;
	}
}

function bearerMatches(actual: string | undefined, token: string): boolean {
	const supplied = Buffer.from(actual ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return (
		token.length > 0 &&
		supplied.length === expected.length &&
		timingSafeEqual(supplied, expected)
	);
}

/** Raw-binary v1 attachment route. Scope is captured before any provider I/O. */
export function createLeadInboundAttachmentRouter(
	options: LeadInboundAttachmentRouterOptions,
): Router {
	const router = Router();
	const activeByCarrier = new Map<string, number>();
	let globalActive = 0;
	router.post("/", async (req, res) => {
		if (!bearerMatches(req.headers.authorization, options.apiToken)) {
			res.status(401).json({
				contentState: "unavailable",
				reason: "scope_denied",
			});
			return;
		}
		const parsed = requestSchema.safeParse(req.body);
		if (
			!parsed.success ||
			Buffer.byteLength(JSON.stringify(req.body ?? null)) > MAX_REQUEST_BYTES
		) {
			res.status(400).json({
				contentState: "unavailable",
				reason: "invalid_metadata",
			});
			return;
		}
		const body = parsed.data;
		if (globalActive >= MAX_GLOBAL_ACTIVE) {
			res.status(503).json({
				requestId: body.requestId,
				contentState: "unavailable",
				reason: "busy",
			});
			return;
		}
		globalActive++;
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 15000);
		const disconnected = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", disconnected);
		res.once("close", disconnected);
		let carrierKey: string | undefined;
		let carrierActive = false;
		let stage: "scope" | "provider" = "scope";
		try {
			const home = options.homeDir ?? homedir();
			const env = options.env ?? process.env;
			const projectsPath =
				options.projectsPath ??
				env.FLYWHEEL_PROJECTS_FILE ??
				join(home, ".flywheel", "projects.json");
			const scope = await (
				options.captureScope ?? captureInboundAttachmentScope
			)({
				projectName: body.projectName,
				leadId: body.leadId,
				identityDigest: body.identityDigest,
				carrierClaim: body.carrierClaim,
				deliveryId: body.deliveryId,
				attachmentId: body.attachmentId,
				projectsPath,
				homeDir: home,
				env,
				commDbPath: options.commDbPath,
			});
			carrierKey = scope.carrierInstanceDigest;
			if ((activeByCarrier.get(carrierKey) ?? 0) >= MAX_CARRIER_ACTIVE)
				throw failure("busy");
			activeByCarrier.set(
				carrierKey,
				(activeByCarrier.get(carrierKey) ?? 0) + 1,
			);
			carrierActive = true;
			await scope.assertCurrent();
			if (body.mode === "validate") {
				if (body.receiptDigest !== scope.receiptDigest)
					throw failure("scope_denied");
				await scope.assertCurrent();
				res.status(204).end();
				return;
			}
			stage = "provider";
			const sizeBytes = scope.attachment.sizeKb * 1024;
			if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
				throw failure("invalid_metadata");
			const result = await (
				options.fetchAttachment ?? fetchInboundDiscordAttachment
			)({
				threadId: scope.originChannelId,
				messageId: scope.messageId,
				attachmentId: body.attachmentId,
				botToken: scope.botToken,
				secrets: [options.apiToken, body.carrierClaim],
				signal: controller.signal,
				assertCurrent: scope.assertCurrent,
				expected: {
					mimeType: scope.attachment.type,
					sizeBytes,
				},
				fetchImpl: options.fetchImpl,
			});
			await scope.assertCurrent();
			if (
				!Buffer.isBuffer(result.data) ||
				result.data.length !== sizeBytes ||
				result.data.length > MAX_RESPONSE_BYTES
			)
				throw failure("invalid_content");
			const contentHash = createHash("sha256")
				.update(result.data)
				.digest("hex");
			await scope.assertCurrent();
			res
				.status(200)
				.set({
					"content-type": result.mimeType,
					"content-length": String(result.data.length),
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"x-flywheel-request-id": body.requestId,
					"x-flywheel-source-message-id": scope.messageId,
					"x-flywheel-source-channel-id": scope.originChannelId,
					"x-flywheel-attachment-id": body.attachmentId,
					"x-flywheel-mime-type": result.mimeType,
					"x-flywheel-bytes": String(result.data.length),
					"x-flywheel-sha256": contentHash,
					"x-flywheel-receipt-digest": scope.receiptDigest,
				})
				.send(result.data);
		} catch (error) {
			const reason =
				error instanceof DiscordInboundAttachmentError
					? error.reason
					: controller.signal.aborted
						? "timeout"
						: stage === "scope"
							? "scope_denied"
							: "fetch_unavailable";
			if (!res.headersSent && !res.destroyed)
				res.status(failureStatus(reason)).json({
					requestId: body.requestId,
					contentState: "unavailable",
					reason,
				});
		} finally {
			clearTimeout(deadline);
			req.off("aborted", disconnected);
			res.off("close", disconnected);
			if (carrierKey && carrierActive) {
				const active = activeByCarrier.get(carrierKey) ?? 0;
				if (active <= 1) activeByCarrier.delete(carrierKey);
				else activeByCarrier.set(carrierKey, active - 1);
			}
			globalActive--;
		}
	});
	return router;
}
