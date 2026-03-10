import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { MemoryService } from "./MemoryService.js";

export interface CreateMemoryServiceOpts {
	googleApiKey?: string;
	qdrantUrl?: string;
	projectName: string;
	llmModel?: string;
}

/**
 * Creates MemoryService if both GOOGLE_API_KEY and QDRANT_URL are provided.
 * Returns undefined otherwise (graceful degradation).
 * History DB stored at ~/.flywheel/memories/<projectName>/history.db.
 */
export function createMemoryService(
	opts: CreateMemoryServiceOpts,
): MemoryService | undefined {
	if (!opts.googleApiKey || !opts.qdrantUrl) return undefined;
	const memoryDbDir = join(
		homedir(),
		".flywheel",
		"memories",
		opts.projectName,
	);
	mkdirSync(memoryDbDir, { recursive: true });
	return new MemoryService({
		googleApiKey: opts.googleApiKey,
		qdrantUrl: opts.qdrantUrl,
		historyDbPath: join(memoryDbDir, "history.db"),
		llmModel: opts.llmModel ?? "gemini-2.0-flash",
	});
}
