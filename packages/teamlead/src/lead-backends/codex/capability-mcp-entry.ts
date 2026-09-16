/** Managed stdio entry. The parent supplies only public capability coordinates. */
import { runBrowserCapabilityProxy } from "./browser-capability-proxy.js";
import { runLeadCapabilityProxy } from "./lead-capability-proxy.js";

try {
	if (process.argv.length !== 3) throw new Error("invalid_mode");
	if (process.argv[2] === "actions") await runLeadCapabilityProxy();
	else if (process.argv[2] === "browser") await runBrowserCapabilityProxy();
	else throw new Error("invalid_mode");
} catch {
	// Paths, manifest contents and provider errors must not enter model-visible logs.
	process.stderr.write("capability_mcp_start_failed\n");
	process.exitCode = 1;
}
