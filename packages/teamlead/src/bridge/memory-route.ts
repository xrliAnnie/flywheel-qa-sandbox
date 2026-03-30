import { Router } from "express";
import type { MemoryService } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import { validateMemoryIds } from "../ProjectConfig.js";

const TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

function isNonEmptyString(val: unknown): val is string {
	return typeof val === "string" && val.length > 0;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function createMemoryRouter(
	memoryService: MemoryService,
	projects: ProjectEntry[],
): Router {
	const router = Router();

	// POST /search
	router.post("/search", async (req, res) => {
		const { query, project_name, agent_id, user_id, limit } = req.body ?? {};

		// Validate required fields
		if (!isNonEmptyString(query)) {
			res.status(400).json({ error: "query must be a non-empty string" });
			return;
		}
		if (!isNonEmptyString(project_name)) {
			res
				.status(400)
				.json({ error: "project_name must be a non-empty string" });
			return;
		}
		// GEO-203: agent_id optional for search (dual-bucket: omit for cross-agent queries)
		if (agent_id !== undefined && !isNonEmptyString(agent_id)) {
			res
				.status(400)
				.json({ error: "agent_id must be a non-empty string if provided" });
			return;
		}
		if (!isNonEmptyString(user_id)) {
			res.status(400).json({ error: "user_id must be a non-empty string" });
			return;
		}

		// Config-based ID validation (GEO-204, GEO-203: optional agentId)
		const idCheck = validateMemoryIds(
			projects,
			project_name,
			agent_id ?? undefined,
			user_id,
		);
		if (!idCheck.valid) {
			res.status(400).json({ error: idCheck.error });
			return;
		}

		// GEO-203: Dual-bucket contract enforcement
		// - No agent_id → shared bucket only: user_id must equal project_name
		// - With agent_id → user_id must be agent_id (private) or project_name (shared)
		if (agent_id === undefined) {
			if (user_id !== project_name) {
				res.status(400).json({
					error:
						"when agent_id is omitted, user_id must equal project_name (shared bucket)",
				});
				return;
			}
		} else {
			if (user_id !== agent_id && user_id !== project_name) {
				res.status(400).json({
					error:
						"user_id must equal agent_id (private bucket) or project_name (shared bucket)",
				});
				return;
			}
		}

		// Validate optional limit
		if (limit !== undefined) {
			if (
				typeof limit !== "number" ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 50
			) {
				res
					.status(400)
					.json({ error: "limit must be an integer between 1 and 50" });
				return;
			}
		}

		try {
			const memories = await withTimeout(
				memoryService.searchMemories({
					query,
					projectName: project_name,
					userId: user_id,
					agentId: agent_id || undefined,
					limit: limit as number | undefined,
				}),
				TIMEOUT_MS,
			);
			res.json({ memories });
		} catch (err) {
			if (err instanceof Error && err.message === "TIMEOUT") {
				res.status(504).json({ error: "mem0 search timed out" });
				return;
			}
			console.error(
				`[memory-route] search error: ${err instanceof Error ? err.message : String(err)}`,
			);
			res.status(502).json({ error: "mem0 search failed" });
		}
	});

	// POST /add
	router.post("/add", async (req, res) => {
		const { messages, project_name, agent_id, user_id, metadata } =
			req.body ?? {};

		// Validate required fields
		if (!isNonEmptyString(project_name)) {
			res
				.status(400)
				.json({ error: "project_name must be a non-empty string" });
			return;
		}
		if (!isNonEmptyString(agent_id)) {
			res.status(400).json({ error: "agent_id must be a non-empty string" });
			return;
		}
		if (!isNonEmptyString(user_id)) {
			res.status(400).json({ error: "user_id must be a non-empty string" });
			return;
		}

		// Config-based ID validation (GEO-204)
		const idCheck = validateMemoryIds(
			projects,
			project_name,
			agent_id,
			user_id,
		);
		if (!idCheck.valid) {
			res.status(400).json({ error: idCheck.error });
			return;
		}

		// Validate messages
		if (!Array.isArray(messages) || messages.length === 0) {
			res.status(400).json({ error: "messages must be a non-empty array" });
			return;
		}
		const validRoles = new Set(["user", "assistant"]);
		for (const msg of messages) {
			if (!isPlainObject(msg)) {
				res.status(400).json({ error: "each message must be an object" });
				return;
			}
			if (!validRoles.has(msg.role as string)) {
				res
					.status(400)
					.json({ error: 'message role must be "user" or "assistant"' });
				return;
			}
			if (!isNonEmptyString(msg.content)) {
				res
					.status(400)
					.json({ error: "message content must be a non-empty string" });
				return;
			}
		}

		// Validate optional metadata
		if (metadata !== undefined) {
			if (!isPlainObject(metadata)) {
				res.status(400).json({ error: "metadata must be a plain object" });
				return;
			}
		}

		try {
			const result = await withTimeout(
				memoryService.addMessages({
					messages: messages as Array<{
						role: "user" | "assistant";
						content: string;
					}>,
					projectName: project_name,
					userId: user_id,
					agentId: agent_id,
					metadata: metadata as Record<string, unknown> | undefined,
				}),
				TIMEOUT_MS,
			);
			res.json(result);
		} catch (err) {
			if (err instanceof Error && err.message === "TIMEOUT") {
				res.status(504).json({ error: "mem0 add timed out" });
				return;
			}
			console.error(
				`[memory-route] add error: ${err instanceof Error ? err.message : String(err)}`,
			);
			res.status(502).json({ error: "mem0 add failed" });
		}
	});

	return router;
}
