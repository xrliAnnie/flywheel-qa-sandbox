import express from "express";
import { LeadConfigError } from "./lead-config-service.js";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";
export interface LeadConfigRouteService {
	stage(input: unknown): Promise<unknown>;
	apply(input: unknown): Promise<unknown>;
	status(operationId: string): Promise<unknown>;
}
/** Same local-operator boundary as workflow publication; authenticate before every receipt read. */
export function createLeadConfigRouter(
	service: LeadConfigRouteService,
): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		const origin = loopbackSelfOrigin(req.headers.host);
		if (
			!origin ||
			!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				req.socket.remoteAddress ?? "",
			) ||
			!isSameOrigin(
				{ origin: req.get("origin"), referer: req.get("referer") },
				origin,
			)
		) {
			res.status(403).json({ ok: false, reason: "local_same_origin_required" });
			return;
		}
		if (
			req.body !== undefined &&
			Buffer.byteLength(JSON.stringify(req.body)) > 16 * 1024
		) {
			res.status(413).json({ ok: false, reason: "request_too_large" });
			return;
		}
		next();
	});
	router.use(express.json({ limit: "16kb" }));
	const execute = async (
		res: express.Response,
		action: () => Promise<unknown>,
	) => {
		try {
			res.json(await action());
		} catch (error) {
			const code =
				error instanceof LeadConfigError
					? error.code
					: error instanceof Error &&
							/^[a-z][a-z0-9_]{1,100}$/.test(error.message)
						? error.message
						: "lead_config_unavailable";
			const invalid =
				code.startsWith("invalid_") ||
				code === "exactly_one_tuning_change_required";
			res
				.status(
					error instanceof LeadConfigError ? error.status : invalid ? 400 : 503,
				)
				.json({ ok: false, reason: code });
		}
	};
	router.post("/stage", (req, res) => {
		void execute(res, () => service.stage(req.body));
	});
	router.post("/apply", (req, res) => {
		void execute(res, () => service.apply(req.body));
	});
	router.get("/operations/:operationId", (req, res) => {
		void execute(res, () => service.status(req.params.operationId));
	});
	return router;
}
