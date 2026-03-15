import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { MemoryService } from "./MemoryService.js";

export interface CreateMemoryServiceOpts {
	googleApiKey?: string;
	supabaseUrl?: string;
	supabaseKey?: string;
	projectName: string;
	llmModel?: string;
}

/**
 * Creates MemoryService if GOOGLE_API_KEY, SUPABASE_URL, and SUPABASE_KEY are provided.
 * Returns undefined otherwise (graceful degradation).
 * History DB stored at ~/.flywheel/memories/<projectName>/history.db.
 *
 * Async because we must await the vendor-patched SupabaseDB.ready promise
 * to verify the table/connection are valid before returning the service.
 */
export async function createMemoryService(
	opts: CreateMemoryServiceOpts,
): Promise<MemoryService | undefined> {
	if (!opts.googleApiKey || !opts.supabaseUrl || !opts.supabaseKey)
		return undefined;

	const safeName = opts.projectName.replace(/[^a-zA-Z0-9_.-]/g, "_");
	const memoryDbDir = join(homedir(), ".flywheel", "memories", safeName);

	try {
		mkdirSync(memoryDbDir, { recursive: true });
	} catch (err) {
		console.warn(
			`[createMemoryService] Cannot create memory DB dir at ${memoryDbDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}

	try {
		const service = new MemoryService({
			googleApiKey: opts.googleApiKey,
			supabaseUrl: opts.supabaseUrl,
			supabaseKey: opts.supabaseKey,
			historyDbPath: join(memoryDbDir, "history.db"),
			llmModel: opts.llmModel ?? "gemini-2.5-flash",
		});

		// Await the vendor-patched SupabaseDB.ready promise.
		// If the patch isn't applied, vectorStore.ready won't exist — fail closed.
		const vectorStore = (service as any).memory?.vectorStore as
			| { ready?: Promise<void>; initError?: Error }
			| undefined;

		if (!vectorStore?.ready) {
			console.warn(
				"[createMemoryService] mem0 SupabaseDB patch not applied — vectorStore.ready missing. Disabling memory.",
			);
			return undefined;
		}

		// Timeout prevents startup hang if Supabase is unreachable
		const INIT_TIMEOUT_MS = 10_000;
		await Promise.race([
			vectorStore.ready,
			new Promise<void>((_, reject) =>
				setTimeout(
					() => reject(new Error("Supabase init timed out")),
					INIT_TIMEOUT_MS,
				),
			),
		]);

		if (vectorStore.initError) {
			console.warn(
				`[createMemoryService] Supabase init failed: ${vectorStore.initError instanceof Error ? vectorStore.initError.message : String(vectorStore.initError)}`,
			);
			return undefined;
		}

		return service;
	} catch (err) {
		console.warn(
			`[createMemoryService] Failed to initialize MemoryService: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}
