/**
 * FLY-727: /api/digest routes — daily completion digest render endpoint.
 *
 * POST /render {day?}  → renders the fleet completion digest for `day` (Pacific
 * civil date, default = yesterday) and returns it as **text/html**. The Bridge
 * NEVER writes files (R3 #2): `scripts/daily-digest.sh` atomically writes the
 * response to $OUT, then hands it to `flywheel-comm publish-report` for hosting +
 * screenshot + Discord delivery (Bridge has no browser).
 *
 * The router is only mounted when `FLYWHEEL_DIGEST_CHANNEL` is configured
 * (default-off, see plugin.ts) — so an unset channel means a 404, not a silent
 * new surface (byte-compat, R3 #1).
 */

import { Router } from "express";
import type { DigestService } from "./digest-service.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createDigestRouter(service: DigestService): Router {
	const router = Router();

	router.post("/render", (req, res) => {
		const body = (req.body ?? {}) as { day?: unknown };
		const day =
			typeof body.day === "string" && DAY_RE.test(body.day)
				? body.day
				: service.defaultDay();
		try {
			const html = service.renderHtml(day);
			res.set("Content-Type", "text/html; charset=utf-8").send(html);
		} catch (err) {
			console.error("[digest/render] failed:", (err as Error).message);
			res
				.status(500)
				.json({ error: `digest render failed: ${(err as Error).message}` });
		}
	});

	return router;
}
