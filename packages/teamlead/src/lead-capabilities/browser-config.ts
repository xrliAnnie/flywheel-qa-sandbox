import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
export const BROWSER_MCP_VERSION = "1.9.0";
/** Captured from tools/list with buildBrowserWorkerSpec flags; verified against the installed pinned package. */
export const BROWSER_UPSTREAM_SCHEMA_DIGEST =
	"b6694f451bb6fec3f381889804020d3fdf53d4c2f20344c523c3c92e613a72b9";
export const BROWSER_URL_PATTERNS = [
	"http://*:*/*",
	"https://*:*/*",
	"about\\:blank",
] as const;
export interface BrowserWorkerSpecInput {
	packageRoot: string;
	nodeExecutable: string;
	chromeExecutable: string;
	qaRoot: string;
	projectRoot: string;
	proxyPort: number;
}
const under = (child: string, parent: string) =>
	child === parent || child.startsWith(`${parent}${sep}`);
const invalid = () => new Error("browser_worker_configuration_invalid");
function path(raw: string, directory: boolean): string {
	if (
		!isAbsolute(raw) ||
		raw === "/" ||
		normalize(raw) !== raw ||
		[...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		throw invalid();
	const resolved = realpathSync(raw);
	if (
		directory ? !statSync(resolved).isDirectory() : !statSync(resolved).isFile()
	)
		throw invalid();
	return resolved;
}
/** Pure startup specification. Only the Seatbelt worker launcher may execute it;
 * parsing these flags is not evidence that the host supports their isolation. */
export function buildBrowserWorkerSpec(input: BrowserWorkerSpecInput) {
	const packageRoot = path(input.packageRoot, true),
		qaRoot = path(input.qaRoot, true),
		projectRoot = path(input.projectRoot, true);
	const nodeExecutable = path(input.nodeExecutable, false),
		chromeExecutable = path(input.chromeExecutable, false);
	if (
		!Number.isInteger(input.proxyPort) ||
		input.proxyPort < 1024 ||
		input.proxyPort > 65535
	)
		throw invalid();
	for (const source of [packageRoot, nodeExecutable, chromeExecutable])
		if (
			under(source, projectRoot) ||
			under(source, qaRoot) ||
			under(qaRoot, source)
		)
			throw invalid();
	if (under(qaRoot, projectRoot) || under(projectRoot, qaRoot)) throw invalid();
	const pkg = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	if (pkg.name !== "chrome-devtools-mcp" || pkg.version !== BROWSER_MCP_VERSION)
		throw invalid();
	const entry = path(
		join(packageRoot, "build", "src", "bin", "chrome-devtools-mcp.js"),
		false,
	);
	if (!under(entry, packageRoot)) throw invalid();
	const artifactRoot = join(qaRoot, "artifacts");
	const chromeLauncher = join(qaRoot, "chrome-arm64");
	return Object.freeze({
		nodeExecutable,
		chromeExecutable,
		chromeLauncher,
		packageRoot,
		qaRoot,
		artifactRoot,
		args: [
			entry,
			"--no-auto-connect",
			"--no-headless",
			"--no-page-id-routing",
			`--executable-path=${chromeLauncher}`,
			`--user-data-dir=${join(qaRoot, "profile")}`,
			`--filesystem-root=${artifactRoot}`,
			"--no-allow-unrestricted-paths",
			"--no-usage-statistics",
			"--no-performance-crux",
			"--redact-network-headers",
			`--proxy-server=http://127.0.0.1:${input.proxyPort}`,
			"--chrome-arg=--proxy-bypass-list=<-loopback>",
			"--chrome-arg=--disable-quic",
			"--chrome-arg=--disable-background-networking",
			"--chrome-arg=--disable-component-update",
			// Lead ed48f532 accepted risk: Chrome cannot nest its renderer sandbox
			// inside Seatbelt. The outer Seatbelt remains the security boundary;
			// credential, symlink, write and direct-egress probes must stay enforced.
			"--chrome-arg=--no-sandbox",
			"--chrome-arg=--disable-crash-reporter",
			"--chrome-arg=--disable-breakpad",
			`--chrome-arg=--crash-dumps-dir=${join(qaRoot, "crashpad")}`,
			// Pinned Chrome's CrashReporterClient uses this switch to override its
			// default host-profile Crashpad path before crash-handler initialization.
			`--chrome-arg=--breakpad-dump-location=${join(qaRoot, "crashpad")}`,
			"--chrome-arg=--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			...BROWSER_URL_PATTERNS.map(
				(pattern) => `--allowed-url-pattern=${pattern}`,
			),
		],
		env: {
			HOME: qaRoot,
			TMPDIR: join(qaRoot, "tmp"),
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
			CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
		},
	});
}
