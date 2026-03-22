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
	 * Search memories and return raw strings (no prompt formatting).
	 * Used by Bridge API. searchAndFormat() reuses this internally.
	 * Strict: throws on malformed response (API route catches → 502).
	 */
	async searchMemories(params: {
		query: string;
		projectName: string;
		userId: string;
		agentId?: string;
		limit?: number;
	}): Promise<string[]> {
		const results = await this.memory.search(params.query, {
			userId: params.userId,
			agentId: params.agentId,
			limit: params.limit ?? this.searchLimit,
			filters: { app_id: params.projectName },
		});

		if (!results || !Array.isArray(results.results)) {
			throw new Error(
				`[MemoryService] Unexpected search response shape: ${JSON.stringify(results)?.slice(0, 200)}`,
			);
		}

		const memories = results.results
			.filter(
				(m: unknown): m is { memory: string } =>
					typeof m === "object" &&
					m !== null &&
					typeof (m as { memory: unknown }).memory === "string",
			)
			.map((m) => m.memory);

		// If mem0 returned items but none had a valid `memory` field, the response is malformed
		if (results.results.length > 0 && memories.length === 0) {
			throw new Error(
				`[MemoryService] All ${results.results.length} search results lack a valid 'memory' field`,
			);
		}

		return memories;
	}

	/**
	 * Add messages to memory with mandatory app_id tagging.
	 * Used by Bridge API. Caller metadata is merged, app_id is enforced.
	 * Strict: throws on malformed response (API route catches → 502).
	 */
	async addMessages(params: {
		messages: Array<{ role: "user" | "assistant"; content: string }>;
		projectName: string;
		userId: string;
		agentId: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ added: number; updated: number }> {
		const result = await this.memory.add(params.messages, {
			userId: params.userId,
			agentId: params.agentId,
			metadata: {
				...params.metadata,
				app_id: params.projectName,
			},
		});

		if (!result || !Array.isArray(result.results)) {
			throw new Error(
				`[MemoryService] Unexpected add response shape: ${JSON.stringify(result)?.slice(0, 200)}`,
			);
		}

		// mem0 add() returns items with `event` at top level or nested in `metadata`
		const items = result.results as Array<{ event?: string; metadata?: { event?: string } }>;
		const getEvent = (r: (typeof items)[number]) => r.event ?? r.metadata?.event;
		const added = items.filter((r) => getEvent(r) === "ADD").length;
		const updated = items.filter((r) => getEvent(r) === "UPDATE").length;

		// If mem0 returned items but none had a recognized event, the response is malformed
		if (items.length > 0 && added === 0 && updated === 0) {
			const sample = JSON.stringify(items[0])?.slice(0, 200);
			throw new Error(
				`[MemoryService] ${items.length} add result(s) lack recognized 'event' field: ${sample}`,
			);
		}

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
		userId: string;
		agentId?: string;
	}): Promise<string | null> {
		try {
			const memories = await this.searchMemories({
				query: params.query,
				projectName: params.projectName,
				userId: params.userId,
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
