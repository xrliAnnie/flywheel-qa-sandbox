import { Memory } from "mem0ai/oss";
import type { MemoryServiceConfig, MemoryServiceTestConfig } from "./types.js";

export class MemoryService {
	private memory: Memory;
	private searchLimit: number;

	constructor(config: MemoryServiceConfig | MemoryServiceTestConfig) {
		this.searchLimit = config.searchLimit ?? 10;

		const isTestConfig = !("qdrantUrl" in config);

		this.memory = new Memory({
			version: "v1.1",
			llm: {
				provider: "google",
				config: {
					apiKey: config.googleApiKey,
					model: config.llmModel ?? "gemini-2.0-flash",
				},
			},
			embedder: {
				provider: "google",
				config: {
					apiKey: config.googleApiKey,
					model: "gemini-embedding-001",
					embeddingDims: 768, // match embedBatch hardcoded value
				},
			},
			vectorStore: isTestConfig
				? {
						provider: "memory",
						config: {
							collectionName: config.collectionName ?? "flywheel-memories",
							dimension: 768,
						},
					}
				: {
						provider: "qdrant",
						config: {
							url: (config as MemoryServiceConfig).qdrantUrl,
							collectionName: config.collectionName ?? "flywheel-memories",
							dimension: 768,
						},
					},
			historyDbPath: config.historyDbPath ?? ":memory:",
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
	 * Search memories relevant to an issue.
	 * Returns formatted prompt block or null if no memories found.
	 */
	async searchAndFormat(params: {
		query: string;
		projectName: string;
		agentId?: string;
	}): Promise<string | null> {
		const results = await this.memory.search(params.query, {
			userId: params.projectName,
			agentId: params.agentId,
			limit: this.searchLimit,
			filters: { app_id: "flywheel" },
		});

		if (!results || !Array.isArray(results.results)) {
			console.warn(
				`[MemoryService] Unexpected response from memory.search(): ${JSON.stringify(results)?.slice(0, 200)}`,
			);
			return null;
		}

		const memories = results.results.filter(
			(m: unknown): m is { memory: string } =>
				typeof m === "object" &&
				m !== null &&
				typeof (m as { memory: unknown }).memory === "string",
		);
		if (!memories.length) return null;

		const lines = memories.map((m) => `- ${m.memory}`);
		return [
			"<project_memory>",
			"## Learned from previous sessions",
			...lines,
			"</project_memory>",
		].join("\n");
	}
}
