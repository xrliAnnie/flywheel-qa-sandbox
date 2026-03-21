import { Memory } from "mem0ai/oss";
import type { MemoryServiceConfig, MemoryServiceTestConfig } from "./types.js";

export class MemoryService {
	private memory: Memory;
	private searchLimit: number;

	constructor(config: MemoryServiceConfig | MemoryServiceTestConfig) {
		this.searchLimit = config.searchLimit ?? 10;

		const isTestConfig = !("supabaseUrl" in config);

		this.memory = new Memory({
			version: "v1.1",
			llm: {
				provider: "google",
				config: {
					apiKey: config.googleApiKey,
					model: config.llmModel ?? "gemini-2.5-flash",
				},
			},
			embedder: {
				provider: "google",
				config: {
					apiKey: config.googleApiKey,
					model: "gemini-embedding-001",
					embeddingDims: 1536,
				},
			},
			vectorStore: isTestConfig
				? {
						provider: "memory",
						config: {
							collectionName: "flywheel-memories",
							dimension: 1536,
						},
					}
				: {
						provider: "supabase",
						config: {
							supabaseUrl: (config as MemoryServiceConfig).supabaseUrl,
							supabaseKey: (config as MemoryServiceConfig).supabaseKey,
							tableName: "memories",
						},
					},
			historyDbPath: isTestConfig
				? (config.historyDbPath ?? ":memory:")
				: (config as MemoryServiceConfig).historyDbPath,
		});
	}

	/**
	 * Store session memories after Blueprint execution.
	 * mem0 internally: LLM extracts facts → generates embeddings → dedup → store.
	 */
	async addSessionMemory(params: {
		projectName: string;
		executionId: string;
		issueId: string;
		issueTitle: string;
		sessionResult: "success" | "failure" | "timeout";
		commitMessages: string[];
		diffSummary: string;
		decisionRoute?: string;
		error?: string;
		decisionReasoning?: string;
		agentId?: string;
	}): Promise<{ added: number; updated: number }> {
		const messages = [
			{
				role: "user" as const,
				content: [
					`Issue: ${params.issueTitle} (${params.issueId})`,
					params.diffSummary ? `Changes:\n${params.diffSummary}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			},
			{
				role: "assistant" as const,
				content: [
					`Session result: ${params.sessionResult}`,
					params.commitMessages.length
						? `Commits:\n${params.commitMessages.map((m) => `- ${m}`).join("\n")}`
						: "No commits",
					params.decisionRoute ? `Decision: ${params.decisionRoute}` : "",
					params.error ? `Error: ${params.error}` : "",
					params.decisionReasoning
						? `Decision reasoning: ${params.decisionReasoning}`
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		];

		const result = await this.memory.add(messages, {
			userId: params.projectName,
			runId: params.executionId,
			agentId: params.agentId,
			metadata: {
				app_id: "flywheel",
				issue_id: params.issueId,
				session_result: params.sessionResult,
			},
		});

		if (!result || !Array.isArray(result.results)) {
			console.warn(
				`[MemoryService] Unexpected response from memory.add(): ${JSON.stringify(result)?.slice(0, 200)}`,
			);
			return { added: 0, updated: 0 };
		}

		// mem0 add() returns items with an `event` field at runtime ("ADD"/"UPDATE")
		// but the SDK types (MemoryItem) don't declare it — cast to access safely
		const items = result.results as Array<{ event?: string }>;
		const added = items.filter((r) => r.event === "ADD").length;
		const updated = items.filter((r) => r.event === "UPDATE").length;

		return { added, updated };
	}

	/**
	 * Search memories and return raw strings (no prompt formatting).
	 * Used by Bridge API. searchAndFormat() reuses this internally.
	 * Strict: throws on malformed response (API route catches → 502).
	 */
	async searchMemories(params: {
		query: string;
		projectName: string;
		agentId?: string;
		limit?: number;
	}): Promise<string[]> {
		const results = await this.memory.search(params.query, {
			userId: params.projectName,
			agentId: params.agentId,
			limit: params.limit ?? this.searchLimit,
			filters: { app_id: "flywheel" },
		});

		if (!results || !Array.isArray(results.results)) {
			throw new Error(
				`[MemoryService] Unexpected search response shape: ${JSON.stringify(results)?.slice(0, 200)}`,
			);
		}

		return results.results
			.filter(
				(m: unknown): m is { memory: string } =>
					typeof m === "object" &&
					m !== null &&
					typeof (m as { memory: unknown }).memory === "string",
			)
			.map((m) => m.memory);
	}

	/**
	 * Add messages to memory with mandatory app_id tagging.
	 * Used by Bridge API. Caller metadata is merged, app_id is enforced.
	 * Strict: throws on malformed response (API route catches → 502).
	 */
	async addMessages(params: {
		messages: Array<{ role: "user" | "assistant"; content: string }>;
		projectName: string;
		agentId: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ added: number; updated: number }> {
		const result = await this.memory.add(params.messages, {
			userId: params.projectName,
			agentId: params.agentId,
			metadata: {
				...params.metadata,
				app_id: "flywheel",
			},
		});

		if (!result || !Array.isArray(result.results)) {
			throw new Error(
				`[MemoryService] Unexpected add response shape: ${JSON.stringify(result)?.slice(0, 200)}`,
			);
		}

		const items = result.results as Array<{ event?: string }>;
		const added = items.filter((r) => r.event === "ADD").length;
		const updated = items.filter((r) => r.event === "UPDATE").length;
		return { added, updated };
	}

	/**
	 * Search memories relevant to an issue.
	 * Returns formatted prompt block or null if no memories found.
	 * Graceful degradation: catches errors and returns null (runner-facing helper).
	 */
	async searchAndFormat(params: {
		query: string;
		projectName: string;
		agentId?: string;
	}): Promise<string | null> {
		try {
			const memories = await this.searchMemories({
				query: params.query,
				projectName: params.projectName,
				agentId: params.agentId,
			});
			if (!memories.length) return null;

			const lines = memories.map((m) => `- ${m}`);
			return [
				"<project_memory>",
				"## Learned from previous sessions",
				...lines,
				"</project_memory>",
			].join("\n");
		} catch (err) {
			console.warn(
				`[MemoryService] searchAndFormat degraded: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	}
}
