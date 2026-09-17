import {
	type Request,
	type RequestHandler,
	type Response,
	Router,
} from "express";
import { XhsBridgeArtifactRegistry } from "./xhs-artifact-registry.js";
import { createXhsArtifactRouter } from "./xhs-artifact-routes.js";
import { xhsBridgeReadPaths } from "./xhs-read-request.js";
import { createXhsReadRouter } from "./xhs-read-routes.js";
import { createXhsWriteRouter } from "./xhs-write-routes.js";

export type XhsRequestTracker = (
	handler: (req: Request, res: Response) => Promise<void>,
) => RequestHandler;
/** Owns one staging registry and the fixed write/media/read HTTP routes. Shutdown drains
 * handler promises as well as sockets: an aborted response is not finished work. */
export function createXhsBridgeWriteService(options: {
	apiToken: string;
	env: NodeJS.ProcessEnv;
	shuttingDown?: () => boolean;
}): { router: Router; close(): Promise<void> } {
	const router = Router();
	const registry = new XhsBridgeArtifactRegistry();
	const pending = new Set<Promise<void>>();
	const connections = new Map<Request, Response>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const shuttingDown = () => closed || options.shuttingDown?.() === true;
	const unavailable = (req: Request) =>
		xhsBridgeReadPaths.includes(req.path)
			? "xhs_read_unavailable"
			: "founder_write_gate_absent";
	const track: XhsRequestTracker = (handler) => (req, res, next) => {
		if (shuttingDown()) {
			res.status(503).json({ code: unavailable(req) });
			return;
		}
		const task = Promise.resolve().then(() => handler(req, res));
		pending.add(task);
		void task.then(
			() => pending.delete(task),
			(error) => {
				pending.delete(task);
				if (!res.destroyed) next(error);
			},
		);
	};
	const paths = [
		"artifact",
		...["prepare", "execute", "status", "cancel"].map(
			(action) => `write/${action}`,
		),
	].map((path) => `/api/lead/xiaohongshu/${path}`);
	router.post([...paths, ...xhsBridgeReadPaths], (req, res, next) => {
		if (shuttingDown()) {
			res
				.status(503)
				.set("cache-control", "no-store")
				.json({ code: unavailable(req) });
			return;
		}
		connections.set(req, res);
		const remove = () => {
			connections.delete(req);
			res.off("finish", remove);
			res.off("close", remove);
		};
		res.once("finish", remove);
		res.once("close", remove);
		next();
	});
	router.use(
		createXhsArtifactRouter({ ...options, registry, shuttingDown, track }),
	);
	router.use(
		createXhsWriteRouter({
			...options,
			artifacts: (scope) => registry.forScope(scope),
			shuttingDown,
			track,
		}),
	);
	router.use(createXhsReadRouter({ ...options, shuttingDown, track }));
	return {
		router,
		close() {
			if (closing) return closing;
			closed = true;
			for (const [req, res] of connections) {
				res.destroy();
				req.destroy();
			}
			closing = (async () => {
				while (pending.size) await Promise.allSettled([...pending]);
				await registry.close();
			})().catch((error) => {
				closing = undefined;
				throw error;
			});
			return closing;
		},
	};
}
