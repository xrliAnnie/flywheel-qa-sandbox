import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { WRITE_OPERATIONS } from "./contracts.js";
import type { XhsWriteExecutor } from "./executor.js";
import {
	type LoginReadOperation,
	loginProjectionSchema,
	loginReadOperation,
	loginStatusSchema,
} from "./login-contract.js";
import { createNativePeerReader } from "./native-peer.js";
import type { XhsWritePreparation } from "./preparation.js";
import {
	publicReadInputs,
	publicReadOperation,
} from "./provider-read-contract.js";
import type { ResourceListOperation } from "./read-resources.js";
import type { WriteIdentity, XhsWriteStore } from "./store.js";

const id = z.string().min(1).max(256);
const envelopeSchema = z
	.object({ projectId: id, leadId: id, activationId: id, input: z.unknown() })
	.strict();
const proposalSchema = z.object({ proposalId: z.string().uuid() }).strict();
const preparedStatusSchema = z.object({ prepareRequestId: id }).strict();
const boundStatusSchema = proposalSchema.extend({
	receiptId: z.string().uuid(),
	contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	operationId: z.enum(WRITE_OPERATIONS),
});
export type WriteIngressContext = {
	identity: WriteIdentity;
	activationId: string;
};
/** Mount only on the inherited public Unix socket. Kernel UID and root registry
 * establish scope; activation is attribution, not authority. The real parent
 * verifies current activation; the service pins attribution into claim/permit. */
export function createWriteIngressHandler(options: {
	modelUid: number;
	peerHelper: { path: string; sha256: string };
	store: Pick<
		XhsWriteStore,
		"status" | "cancel" | "executionRecord" | "preparedStatus"
	>;
	scope: (
		peerUid: number,
		selection: { projectId: string; leadId: string; activationId: string },
		signal: AbortSignal,
		purpose?: "read" | "write",
	) => Promise<WriteIngressContext | null>;
	preparation: Pick<XhsWritePreparation, "prepare">;
	executor: (context: WriteIngressContext) => Pick<XhsWriteExecutor, "execute">;
	readLogin?: (
		context: WriteIngressContext,
		action: LoginReadOperation,
		signal: AbortSignal,
	) => Promise<unknown>;
	readDetail?: (
		context: WriteIngressContext,
		input: unknown,
		signal: AbortSignal,
	) => Promise<string>;
	readList?: (
		context: WriteIngressContext,
		action: ResourceListOperation,
		input: unknown,
		signal: AbortSignal,
	) => Promise<string>;
	readFeeds?: (
		context: WriteIngressContext,
		signal: AbortSignal,
	) => Promise<string>;
	now?: () => number;
}) {
	const readPeer = createNativePeerReader(options.peerHelper);
	const now = options.now ?? Date.now;
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		const timer = setTimeout(() => {
			controller.abort();
			req.destroy();
			res.destroy();
		}, 180000);
		const check = () => {
			if (controller.signal.aborted || req.socket.destroyed) throw Error();
		};
		const reply = (status: number, body: unknown) => {
			if (res.destroyed) return;
			res.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(body));
		};
		try {
			const peerUid = await readPeer(req.socket, controller.signal);
			check();
			if (
				peerUid !== options.modelUid ||
				req.method !== "POST" ||
				![
					...loginReadOperation.options.map(
						(operation) => `/v1/read/${operation}`,
					),
					...publicReadOperation.options.map(
						(operation) => `/v1/read/${operation}`,
					),
					"/v1/write/prepare",
					"/v1/write/execute",
					"/v1/write/status",
					"/v1/write/cancel",
				].includes(req.url ?? "") ||
				req.headers["content-type"] !== "application/json"
			)
				throw Error();
			let size = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				if (size > 256 * 1024) throw Error();
				chunks.push(bytes);
			}
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks),
			);
			const request = envelopeSchema.parse(parseStrictJson(raw));
			const context = structuredClone(
				await options.scope(
					peerUid,
					{
						projectId: request.projectId,
						leadId: request.leadId,
						activationId: request.activationId,
					},
					controller.signal,
					req.url?.startsWith("/v1/read/") ? "read" : "write",
				),
			);
			check();
			if (
				!context ||
				context.identity.requesterUid !== peerUid ||
				context.identity.projectId !== request.projectId ||
				context.identity.leadId !== request.leadId ||
				context.activationId !== request.activationId
			)
				throw Error();
			if (req.url?.startsWith("/v1/read/")) {
				const login = loginReadOperation.safeParse(
					req.url.slice("/v1/read/".length),
				);
				if (login.success) {
					z.object({}).strict().parse(request.input);
					if (!options.readLogin) throw Error();
					const result = await options.readLogin(
						context,
						login.data,
						controller.signal,
					);
					check();
					reply(
						200,
						(login.data === "get_login_qrcode"
							? loginProjectionSchema
							: loginStatusSchema
						).parse(result),
					);
					return;
				}
				const action = publicReadOperation.parse(
					req.url.slice("/v1/read/".length),
				);
				const input = publicReadInputs[action].parse(request.input);
				let text: string;
				if (action === "get_feed_detail") {
					if (!options.readDetail) throw Error();
					text = await options.readDetail(context, input, controller.signal);
				} else if (action === "list_feeds") {
					if (!options.readFeeds) throw Error();
					text = await options.readFeeds(context, controller.signal);
				} else {
					if (!options.readList) throw Error();
					text = await options.readList(
						context,
						action,
						input,
						controller.signal,
					);
				}
				check();
				if (typeof text !== "string" || Buffer.byteLength(text) > 196608)
					throw Error();
				reply(200, { text });
				return;
			}
			if (req.url === "/v1/write/prepare") {
				const input = z.record(z.string(), z.unknown()).parse(request.input);
				if (
					"projectId" in input ||
					"leadId" in input ||
					"activationId" in input
				)
					throw Error();
				const result = await options.preparation.prepare(
					peerUid,
					{
						...input,
						projectId: request.projectId,
						leadId: request.leadId,
						activationId: context.activationId,
					},
					controller.signal,
				);
				check();
				reply(200, {
					proposalId: result.proposalId,
					contentDigest: result.contentDigest,
					state: result.state,
					expiresAt: result.expiresAt,
					cardRef: result.cardRef,
				});
				return;
			}
			if (req.url === "/v1/write/execute") {
				const result = await options
					.executor(context)
					.execute(request.input, controller.signal);
				check();
				reply(
					200,
					result.kind === "attempt"
						? {
								kind: result.kind,
								attemptId: result.attemptId,
								state: result.state,
							}
						: { kind: result.kind, code: result.code },
				);
				return;
			}
			if (
				req.url === "/v1/write/status" &&
				preparedStatusSchema.safeParse(request.input).success
			) {
				const { prepareRequestId } = preparedStatusSchema.parse(request.input);
				const prepared = options.store.preparedStatus(
					prepareRequestId,
					context.identity,
				);
				if (!prepared) throw Error();
				reply(200, prepared);
				return;
			}
			const query =
				req.url === "/v1/write/status"
					? z.union([proposalSchema, boundStatusSchema]).parse(request.input)
					: proposalSchema.parse(request.input);
			const { proposalId } = query;
			if ("receiptId" in query) {
				const bound = boundStatusSchema.parse(query);
				const record = options.store.executionRecord(
					proposalId,
					bound.contentDigest,
					context.identity,
					now,
				);
				if (
					record.receiptId !== bound.receiptId ||
					record.frozen.operationId !== bound.operationId
				)
					throw Error();
			}
			const status = options.store.status(proposalId, context.identity);
			if (!status) throw Error();
			if (req.url === "/v1/write/cancel")
				reply(200, {
					state: options.store.cancel(proposalId, context.identity, now()),
				});
			else reply(200, status);
		} catch {
			if (!res.headersSent) reply(403, { code: "write_ingress_denied" });
		} finally {
			clearTimeout(timer);
			req.off("aborted", abort);
			res.off("close", abort);
		}
	};
}
