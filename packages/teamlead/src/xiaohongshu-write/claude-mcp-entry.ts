import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClaudeXhsWriteMcp } from "./claude-mcp.js";

try {
	if (process.argv.length !== 2) throw Error();
	await createClaudeXhsWriteMcp({ env: process.env }).connect(
		new StdioServerTransport(),
	);
} catch {
	process.stderr.write("xhs_mcp_start_failed\n");
	process.exitCode = 1;
}
