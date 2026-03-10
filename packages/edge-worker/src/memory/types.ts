export interface MemoryServiceConfig {
	/** Google AI API key for Gemini LLM + embedding */
	googleApiKey: string;
	/** Qdrant URL for persistent vector storage (REQUIRED for persistence) */
	qdrantUrl: string;
	/** mem0 history DB path — MUST be outside repo to avoid git dirty tree
	 *  default: ~/.flywheel/memories/<projectName>/history.db */
	historyDbPath: string;
	/** Vector collection name (default: flywheel-memories) */
	collectionName?: string;
	/** Gemini model for fact extraction (default: gemini-2.0-flash) */
	llmModel?: string;
	/** Max memories to return on search (default: 10) */
	searchLimit?: number;
}

/** Config for tests only — in-memory vector store, no Qdrant needed */
export interface MemoryServiceTestConfig {
	googleApiKey: string;
	historyDbPath?: string;
	collectionName?: string;
	llmModel?: string;
	searchLimit?: number;
}
