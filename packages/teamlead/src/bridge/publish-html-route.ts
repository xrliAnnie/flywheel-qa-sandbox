/**
 * GEO-294: POST /api/publish-html — generic HTML publishing endpoint.
 * Accepts HTML content, deploys to Vercel, returns public URL.
 * Bridge is pure infrastructure — no triage logic.
 */

import { Router } from "express";
import { deployToVercel } from "./vercel-deploy.js";

const MAX_HTML_SIZE = 512 * 1024; // 512 KB

export function createPublishHtmlRouter(
	vercelToken: string | undefined,
): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		if (!vercelToken) {
			res.status(501).json({
				error: "HTML publishing not available — VERCEL_TOKEN not configured",
			});
			return;
		}

		const body = (req.body ?? {}) as Record<string, unknown>;

		const { projectName, html } = body;
		if (typeof projectName !== "string" || projectName.trim().length === 0) {
			res.status(400).json({
				error: "projectName is required and must be a non-empty string",
			});
			return;
		}
		// Sanitize projectName to valid Vercel project/domain name
		const sanitized = projectName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		if (sanitized.length === 0) {
			res.status(400).json({
				error: "projectName must contain at least one alphanumeric character",
			});
			return;
		}
		if (typeof html !== "string" || html.trim().length === 0) {
			res.status(400).json({
				error: "html is required and must be a non-empty string",
			});
			return;
		}
		if (Buffer.byteLength(html, "utf-8") > MAX_HTML_SIZE) {
			res.status(400).json({
				error: `html exceeds maximum size of ${MAX_HTML_SIZE} bytes`,
			});
			return;
		}

		try {
			const result = await deployToVercel(vercelToken, sanitized, html);
			res.json({ url: result.url });
		} catch (err) {
			console.error("[publish-html] deploy failed:", (err as Error).message);
			res.status(502).json({ error: "HTML publishing failed" });
		}
	});

	return router;
}
