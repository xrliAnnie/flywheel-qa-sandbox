import { createHash, timingSafeEqual } from "node:crypto";
import { type ErrorRequestHandler, Router, raw } from "express";
import type { LeadArtifactStore } from "../lead-capabilities/artifacts.js";
import { authorityResponseSchemas } from "../xiaohongshu-write/authority-client.js";
import { artifactSchema } from "../xiaohongshu-write/contracts.js";
import { createBridgeXhsWriteClient } from "../xiaohongshu-write/parent-client-policy.js";
import { createXhsWriteContext } from "./xhs-write-context.js";
import { parseXhsWriteRequest } from "./xhs-write-request.js";
import type { XhsRequestTracker } from "./xhs-write-service.js";

/** Mount before the global JSON parser, preserving duplicate-key rejection.
 * artifacts must resolve a parent-owned registry for this exact current scope. */
export function createXhsWriteRouter(options: {
	apiToken: string;
	env: NodeJS.ProcessEnv;
	artifacts(
		scope: ReturnType<typeof createXhsWriteContext>["scope"],
	): Pick<LeadArtifactStore, "read">;
	shuttingDown?: () => boolean;
	track?: XhsRequestTracker;
}): Router {
	const router = Router();
	const track: XhsRequestTracker = options.track ?? ((handler) => handler);
	const env = Object.freeze({ ...options.env });
	const expected = Buffer.from(`Bearer ${options.apiToken}`);
	const paths = ["prepare", "execute", "status", "cancel"].map(
		(action) => `/api/lead/xiaohongshu/write/${action}`,
	);
	router.post(
		paths,
		(req, res, next) => {
			if (!options.apiToken) {
				res.status(503).json({ code: "founder_write_gate_absent" });
				return;
			}
			const supplied = Buffer.from(req.headers.authorization ?? "");
			if (
				supplied.length !== expected.length ||
				!timingSafeEqual(supplied, expected)
			) {
				res.status(401).json({ code: "unauthorized" });
				return;
			}
			next();
		},
		raw({ type: "application/json", limit: 262144 }),
		track(async (req, res) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			req.once("aborted", abort);
			res.once("close", abort);
			const timer = setTimeout(() => {
				abort();
				res.destroy();
			}, 180000);
			let phase: "request" | "identity" | "work" = "request";
			const reply = (status: number, data: unknown) => {
				if (res.destroyed || res.headersSent) return;
				const json = JSON.stringify(data);
				if (Buffer.byteLength(json) > 65536) throw Error();
				res
					.status(status)
					.set("cache-control", "no-store")
					.type("application/json")
					.send(json);
			};
			try {
				if (!Buffer.isBuffer(req.body)) throw Error();
				const request = parseXhsWriteRequest(
					req.originalUrl,
					new TextDecoder("utf-8", { fatal: true }).decode(req.body),
				);
				phase = "identity";
				const context = createXhsWriteContext(
					req.headers["x-flywheel-lead-context"],
					env,
				);
				const current = () => {
					controller.signal.throwIfAborted();
					if (options.shuttingDown?.()) throw Error();
					context.assertCurrent();
				};
				current();
				const client = createBridgeXhsWriteClient({
					policyPath: "/Library/Application Support/Flywheel/Xhs/policy.json",
					scope: context.scope,
					assertCurrent: current,
				});
				phase = "work";
				let output: unknown;
				if (request.action === "prepare") {
					const artifactIds: string[] = [];
					for (const handle of request.input.artifactHandles) {
						current();
						const { artifact, data: original } = await options
							.artifacts(context.scope)
							.read(handle);
						const data = Buffer.from(original);
						current();
						const mimeType = artifactSchema.shape.mimeType.parse(
							artifact.mimeType,
						);
						if (
							artifact.handle !== handle ||
							data.length !== artifact.size ||
							data.length > 10 * 1024 * 1024 ||
							createHash("sha256").update(data).digest("hex") !==
								artifact.sha256
						)
							throw Error();
						const imported = artifactSchema.parse(
							await client.importArtifact(
								{ data, mimeType },
								controller.signal,
							),
						);
						current();
						if (
							imported.sha256 !== artifact.sha256 ||
							imported.sizeBytes !== data.length ||
							imported.mimeType !== mimeType
						)
							throw Error();
						artifactIds.push(imported.artifactId);
					}
					current();
					output = authorityResponseSchemas.prepare.parse(
						await client.call(
							"prepare",
							{
								prepareRequestId: request.requestId,
								operationId: request.input.operationId,
								accountSelector: request.input.accountSelector,
								payload: request.input.payload,
								artifactIds,
								targetHandle: request.input.resourceHandle ?? null,
							},
							controller.signal,
						),
					);
				} else if (request.action === "execute") {
					current();
					output = authorityResponseSchemas.execute.parse(
						await client.call(
							"execute",
							{
								proposalId: request.input.proposalId,
								receiptId: request.input.receiptId,
								contentDigest: request.input.expectedContentDigest,
								operationId: request.input.operationId,
								executeRequestId: request.requestId,
							},
							controller.signal,
						),
					);
				} else {
					current();
					const result = authorityResponseSchemas[request.action].parse(
						await client.call(request.action, request.input, controller.signal),
					);
					if (
						"proposalId" in result &&
						result.proposalId !== request.input.proposalId
					)
						throw Error();
					output = result;
				}
				current();
				reply(200, output);
			} catch {
				reply(phase === "request" ? 400 : phase === "identity" ? 403 : 503, {
					code:
						phase === "request"
							? "xhs_request_invalid"
							: phase === "identity"
								? "founder_write_gate_absent"
								: "xhs_result_unknown",
				});
			} finally {
				clearTimeout(timer);
				req.off("aborted", abort);
				res.off("close", abort);
			}
		}),
	);
	const parseError: ErrorRequestHandler = (_error, _req, res, _next) => {
		res.status(400).json({ code: "xhs_request_invalid" });
	};
	router.use(parseError);
	return router;
}
