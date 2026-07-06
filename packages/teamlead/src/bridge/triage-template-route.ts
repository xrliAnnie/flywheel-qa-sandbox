/**
 * FLY-27: GET /api/triage/template — serves static HTML triage template.
 *
 * Simba fetches this template, replaces placeholders with triage data,
 * then publishes via /api/publish-html. This avoids LLM generating
 * 300 lines of HTML+CSS from scratch on every triage run.
 */

import { readFileSync } from "node:fs";
import { Router } from "express";

export function createTriageTemplateRouter(templatePath: string): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		try {
			const content = readFileSync(templatePath, "utf-8");
			res.type("html").send(content);
		} catch (err) {
			console.error(
				"[triage-template] Failed to read template:",
				(err as Error).message,
			);
			res.status(500).json({ error: "Template file not found" });
		}
	});

	return router;
}
