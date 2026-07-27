import { migrateDatabase } from "flywheel-v2-kernel";

const dbPath = process.argv[2];
if (!dbPath) {
	throw new Error("database path is required");
}

process.send?.({ type: "ready" });
process.once("message", (message) => {
	if (message !== "go") {
		throw new Error(`unexpected parent message: ${String(message)}`);
	}
	try {
		const result = migrateDatabase({ path: dbPath, busyTimeoutMs: 5_000 });
		process.send?.({ type: "result", result });
		process.exit(0);
	} catch (error) {
		process.send?.({
			type: "error",
			error: error instanceof Error ? error.stack : String(error),
		});
		process.exit(1);
	}
});
