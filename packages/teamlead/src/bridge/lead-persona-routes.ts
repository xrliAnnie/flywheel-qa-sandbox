import express from "express";
import type { ActivationView } from "./lead-persona-activation.js";

export interface LeadPersonaRouterDeps {
	readActivation(projectName: string, leadId: string): Promise<ActivationView>;
}

export function createLeadPersonaRouter(
	deps: LeadPersonaRouterDeps,
): express.Router {
	const router = express.Router();
	router.get("/activation", async (req, res) => {
		const keys = Object.keys(req.query);
		const projectName = req.query.projectName;
		const leadId = req.query.leadId;
		if (
			keys.length !== 2 ||
			!keys.includes("projectName") ||
			!keys.includes("leadId") ||
			typeof projectName !== "string" ||
			typeof leadId !== "string" ||
			projectName.length === 0 ||
			leadId.length === 0 ||
			projectName !== projectName.trim() ||
			leadId !== leadId.trim()
		) {
			res.status(400).json({ kind: "refused", reason: "invalid_arguments" });
			return;
		}
		try {
			res.json(await deps.readActivation(projectName, leadId));
		} catch (error) {
			res.status(503).json({
				kind: "refused",
				reason:
					error instanceof Error ? error.message : "activation_unavailable",
			});
		}
	});
	return router;
}
