import { isAbsolute } from "node:path";
import {
	BoundedStdioTransport,
	type PinnedStdioLaunch,
} from "./bounded-stdio-transport.js";
export type BrowserSandboxLaunch = PinnedStdioLaunch;
const allowedEnv = new Set([
	"HOME",
	"TMPDIR",
	"PATH",
	"LANG",
	"CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS",
	"CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS",
]);
/** The browser still requires its trusted Seatbelt launch; no ambient environment merge. */
export class BrowserStdioTransport extends BoundedStdioTransport {
	constructor(launch: BrowserSandboxLaunch) {
		if (
			launch.command !== "/usr/bin/sandbox-exec" ||
			launch.args[0] !== "-p" ||
			!launch.args[1] ||
			!isAbsolute(launch.args[2] ?? "") ||
			Object.keys(launch.env).some((key) => !allowedEnv.has(key))
		)
			throw new Error("browser_transport_configuration_invalid");
		super(launch, { errorCode: "browser_lost" });
	}
}
