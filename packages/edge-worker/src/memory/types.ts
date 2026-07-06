export interface MemoryServiceConfig {
	/** Google AI API key for Gemini LLM + embedding */
	googleApiKey: string;
	/** Supabase project URL (e.g. https://xxx.supabase.co) */
	supabaseUrl: string;
	/** Supabase service role key (bypasses RLS) */
	supabaseKey: string;
	/** mem0 history DB path — MUST be outside repo to avoid git dirty tree
	 *  default: ~/.flywheel/memories/<projectName>/history.db */
	historyDbPath: string;
	/** Gemini model for fact extraction (default: gemini-2.0-flash) */
	llmModel?: string;
	/** Max memories to return on search (default: 10) */
	searchLimit?: number;
}

/** Config for tests only — in-memory vector store, no Supabase needed */
export interface MemoryServiceTestConfig {
	googleApiKey: string;
	historyDbPath?: string;
	llmModel?: string;
	searchLimit?: number;
}
