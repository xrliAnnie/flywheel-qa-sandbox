import { timingSafeEqual } from "node:crypto";
import { type ErrorRequestHandler, Router, raw } from "express";
import { authorityResponseSchemas } from "../xiaohongshu-write/authority-client.js";
import { createBridgeXhsWriteClient } from "../xiaohongshu-write/parent-client-policy.js";
import { parseXhsReadRequest, xhsBridgeReadPaths } from "./xhs-read-request.js";
import { createXhsWriteContext } from "./xhs-write-context.js";
import type { XhsRequestTracker } from "./xhs-write-service.js";

/** Same current identity as writes; founder write-enable is not a read gate. */
export function createXhsReadRouter(options: {
	apiToken: string;
	env: NodeJS.ProcessEnv;
	shuttingDown?: () => boolean;
	track?: XhsRequestTracker;
}): Router {
	const router = Router();
	const env = Object.freeze({ ...options.env });
	const expected = Buffer.from(`Bearer ${options.apiToken}`);
	const track: XhsRequestTracker = options.track ?? ((handler) => handler);
	router.post(
		xhsBridgeReadPaths,
		(req, res, next) => {
			if (!options.apiToken) {
				res.status(503).json({ code: "xhs_read_unavailable" });
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
		raw({ type: "application/json", limit: 262144, inflate: false }),
		track(async (req, res) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			req.once("aborted", abort);
			res.once("close", abort);
			const timer = setTimeout(() => {
				abort();
				res.destroy();
			}, 180000);
			let validRequest = false;
			try {
				if (!Buffer.isBuffer(req.body)) throw Error();
				const request = parseXhsReadRequest(
					req.originalUrl,
					new TextDecoder("utf-8", { fatal: true }).decode(req.body),
				);
				validRequest = true;
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
				const result = authorityResponseSchemas[request.action].parse(
					await client.call(request.action, request.input, controller.signal),
				);
				current();
				if (request.action === "get_login_qrcode") {
					const qr = authorityResponseSchemas.get_login_qrcode.parse(result);
					if (
						!qr.loggedIn &&
						(qr.expiresAt <= Date.now() || qr.expiresAt > Date.now() + 240000)
					)
						throw Error();
				}
				const json = JSON.stringify(result);
				if (
					Buffer.byteLength(json) >
					(request.action === "get_login_qrcode" ? 540000 : 262144)
				)
					throw Error();
				if (!res.destroyed && !res.headersSent)
					res
						.status(200)
						.set("cache-control", "no-store")
						.type("application/json")
						.send(json);
			} catch {
				if (!res.destroyed && !res.headersSent)
					res
						.status(validRequest ? 503 : 400)
						.set("cache-control", "no-store")
						.json({
							code: validRequest
								? "xhs_read_unavailable"
								: "xhs_request_invalid",
						});
			} finally {
				clearTimeout(timer);
				req.off("aborted", abort);
				res.off("close", abort);
			}
		}),
	);
	const parseError: ErrorRequestHandler = (_error, _req, res, _next) => {
		if (!res.destroyed) res.status(400).json({ code: "xhs_request_invalid" });
	};
	router.use(parseError);
	return router;
}
