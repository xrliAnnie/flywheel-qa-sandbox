import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { artifactSchema } from "../xiaohongshu-write/contracts.js";
import { createBridgeXhsWriteClient } from "../xiaohongshu-write/parent-client-policy.js";
import type { XhsBridgeArtifactRegistry } from "./xhs-artifact-registry.js";
import { XhsStagingLeftoversError } from "./xhs-staging-leftovers.js";
import { createXhsWriteContext } from "./xhs-write-context.js";
import type { XhsRequestTracker } from "./xhs-write-service.js";

/** Binary intake only. Mount before body parsers; media decoding remains the
 * authority's responsibility before any founder card or provider write. */
export function createXhsArtifactRouter(options: {
	apiToken: string;
	env: NodeJS.ProcessEnv;
	registry: XhsBridgeArtifactRegistry;
	shuttingDown?: () => boolean;
	track?: XhsRequestTracker;
}): Router {
	const router = Router();
	const env = Object.freeze({ ...options.env });
	const expected = Buffer.from(`Bearer ${options.apiToken}`);
	let active = 0;
	const track: XhsRequestTracker = options.track ?? ((handler) => handler);
	router.post(
		"/api/lead/xiaohongshu/artifact",
		track(async (req, res) => {
			const reply = (status: number, code: string) => {
				if (!res.destroyed && !res.headersSent)
					res.status(status).set("cache-control", "no-store").json({ code });
			};
			if (!options.apiToken) {
				reply(503, "founder_write_gate_absent");
				return;
			}
			const supplied = Buffer.from(req.headers.authorization ?? "");
			if (
				supplied.length !== expected.length ||
				!timingSafeEqual(supplied, expected)
			) {
				reply(401, "unauthorized");
				return;
			}
			if (active >= 4) {
				reply(503, "xhs_artifact_unavailable");
				return;
			}
			active++;
			const controller = new AbortController();
			const abort = () => controller.abort();
			req.once("aborted", abort);
			res.once("close", abort);
			const timer = setTimeout(() => {
				abort();
				req.destroy();
				res.destroy();
			}, 180000);
			let phase: "request" | "identity" | "work" = "request";
			try {
				if (
					req.originalUrl !== "/api/lead/xiaohongshu/artifact" ||
					req.headers["content-encoding"] !== undefined
				)
					throw Error();
				const mime = artifactSchema.shape.mimeType.parse(
					req.headers["content-type"],
				);
				const declared = req.headers["content-length"];
				const cap = 10 * 1024 * 1024;
				if (
					declared !== undefined &&
					(!/^[1-9][0-9]*$/.test(declared) || Number(declared) > cap)
				)
					throw Error();
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
				const policy = () => {
					current();
					createBridgeXhsWriteClient({
						policyPath: "/Library/Application Support/Flywheel/Xhs/policy.json",
						scope: context.scope,
						assertCurrent: current,
					});
				};
				policy();
				const projectRoot = context.projectRoot();
				phase = "request";
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of req.iterator({ destroyOnReturn: false })) {
					phase = "identity";
					current();
					phase = "request";
					if (!(chunk instanceof Uint8Array)) throw Error();
					size += chunk.byteLength;
					if (size > cap) throw Error();
					chunks.push(Buffer.from(chunk));
				}
				if (size === 0 || (declared !== undefined && size !== Number(declared)))
					throw Error();
				phase = "identity";
				policy();
				if (context.projectRoot() !== projectRoot) throw Error();
				phase = "work";
				// Keep the registry's guard activation-scoped, not bound to this HTTP response.
				const artifact = await options.registry.put(
					{
						scope: context.scope,
						projectRoot,
						assertCurrent: () => context.assertCurrent(),
					},
					Buffer.concat(chunks, size),
					mime,
				);
				current();
				if (!res.destroyed && !res.headersSent)
					res.status(200).set("cache-control", "no-store").json(artifact);
			} catch (error) {
				if (error instanceof XhsStagingLeftoversError) {
					reply(503, "staging_leftovers_exceeded");
					return;
				}
				reply(
					phase === "request" ? 400 : phase === "identity" ? 403 : 503,
					phase === "request"
						? "xhs_request_invalid"
						: phase === "identity"
							? "founder_write_gate_absent"
							: "xhs_artifact_unavailable",
				);
			} finally {
				clearTimeout(timer);
				req.off("aborted", abort);
				res.off("close", abort);
				active--;
			}
		}),
	);
	return router;
}
