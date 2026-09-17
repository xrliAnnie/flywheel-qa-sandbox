import { importClaudeXhsMedia } from "./claude-media.js";

try {
	if (process.argv.length !== 3) throw Error("xhs_request_invalid");
	const artifact = await importClaudeXhsMedia(
		process.stdin,
		process.argv[2]!,
		process.env,
	);
	process.stdout.write(`${JSON.stringify(artifact)}\n`);
} catch (error) {
	const code =
		error instanceof Error &&
		["xhs_request_invalid", "founder_write_gate_absent"].includes(error.message)
			? error.message
			: "xhs_result_unknown";
	process.stderr.write(`${code}\n`);
	process.exitCode = 1;
}
