import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildBrowserWorkerSpec } from "../browser-config.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("pins a separate visible pipe browser and never copies parent credentials", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2519-browser-config-"));
	dirs.push(root);
	const packageRoot = join(root, "deployment", "chrome-devtools-mcp"),
		qaRoot = join(root, "qa"),
		projectRoot = join(root, "project");
	mkdirSync(join(packageRoot, "build", "src", "bin"), { recursive: true });
	mkdirSync(qaRoot);
	mkdirSync(projectRoot);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "chrome-devtools-mcp", version: "1.9.0" }),
	);
	writeFileSync(
		join(packageRoot, "build", "src", "bin", "chrome-devtools-mcp.js"),
		"// pinned fixture",
	);
	const chromeExecutable = join(root, "Chrome");
	writeFileSync(chromeExecutable, "");
	const spec = buildBrowserWorkerSpec({
		packageRoot,
		qaRoot,
		projectRoot,
		chromeExecutable,
		nodeExecutable: process.execPath,
		proxyPort: 4311,
	});
	expect(spec.args).toContain("--no-headless");
	expect(spec.args).toContain("--no-auto-connect");
	expect(spec.args).toContain("--no-page-id-routing");
	expect(spec.args).toContain("--no-usage-statistics");
	expect(spec.args).toContain("--no-performance-crux");
	expect(spec.args).toContain("--chrome-arg=--proxy-bypass-list=<-loopback>");
	for (const flag of [
		"--no-sandbox",
		"--disable-crash-reporter",
		"--disable-breakpad",
		`--crash-dumps-dir=${join(spec.qaRoot, "crashpad")}`,
		`--breakpad-dump-location=${join(spec.qaRoot, "crashpad")}`,
	])
		expect(spec.args).toContain(`--chrome-arg=${flag}`);
	expect(spec.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe("1");
	expect(spec.env.HOME).toBe(spec.qaRoot);
	expect(spec.args.join(" ")).not.toMatch(
		/browser-url|ws-endpoint|remote-debugging-port/,
	);
	expect(() =>
		buildBrowserWorkerSpec({
			packageRoot,
			qaRoot: projectRoot,
			projectRoot,
			chromeExecutable,
			nodeExecutable: process.execPath,
			proxyPort: 4311,
		}),
	).toThrow(/browser/);
});

it("matches the installed pinned MCP parser and URLPattern scheme restrictions without launching a worker", async () => {
	const { createRequire } = await import("node:module");
	const { dirname } = await import("node:path");
	const { pathToFileURL } = await import("node:url");
	const { BROWSER_URL_PATTERNS } = await import("../browser-config.js");
	const packageRoot = dirname(
		createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json"),
	);
	const root = mkdtempSync(join(tmpdir(), "fly2519-browser-parser-"));
	dirs.push(root);
	const qaRoot = join(root, "qa"),
		projectRoot = join(root, "project");
	mkdirSync(qaRoot);
	mkdirSync(projectRoot);
	const spec = buildBrowserWorkerSpec({
		packageRoot,
		qaRoot,
		projectRoot,
		nodeExecutable: process.execPath,
		chromeExecutable: process.execPath,
		proxyPort: 4311,
	});
	const { parseArguments } = await import(
		pathToFileURL(join(packageRoot, "build/src/config/mcp-options.js")).href
	);
	const parsed = parseArguments(
		"1.9.0",
		[spec.nodeExecutable, ...spec.args],
		spec.env,
	);
	expect(parsed.headless).toBe(false);
	expect(parsed.autoConnect).not.toBe(true);
	expect(parsed.pageIdRouting).toBe(false);
	expect(parsed.usageStatistics).toBe(false);
	expect(parsed.performanceCrux).toBe(false);
	expect(parsed.redactNetworkHeaders).toBe(true);
	expect(parsed.proxyServer).toBe("http://127.0.0.1:4311");
	expect(parsed.filesystemRoot).toEqual([spec.artifactRoot]);
	expect(parsed.allowedUrlPattern).toEqual([...BROWSER_URL_PATTERNS]);
	const Pattern = (
		globalThis as unknown as {
			URLPattern: new (pattern: string) => { test(url: string): boolean };
		}
	).URLPattern;
	const patterns = BROWSER_URL_PATTERNS.map((pattern) => new Pattern(pattern));
	for (const url of [
		"https://example.com/report",
		"http://localhost:4312/report",
		"about:blank",
	])
		expect(patterns.some((pattern) => pattern.test(url))).toBe(true);
	for (const url of [
		"file:///tmp/secret",
		"data:text/html,test",
		"javascript:1",
		"chrome://settings",
		"about:config",
	])
		expect(patterns.some((pattern) => pattern.test(url))).toBe(false);
});

it("redacts Cookie and Set-Cookie in actual upstream text and structured network formatting", async () => {
	const { createRequire } = await import("node:module");
	const { dirname } = await import("node:path");
	const { pathToFileURL } = await import("node:url");
	const root = dirname(
		createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json"),
	);
	const { NetworkFormatter } = await import(
		pathToFileURL(join(root, "build/src/formatters/NetworkFormatter.js")).href
	);
	const request = {
		method: () => "GET",
		url: () => "https://example.com",
		failure: () => null,
		redirectChain: () => [],
		headers: () => ({
			Cookie: "qa-cookie-secret",
			Authorization: "Bearer qa-auth-secret",
			Accept: "text/html",
		}),
		response: () => ({
			status: () => 200,
			headers: () => ({
				"Set-Cookie": "qa-response-secret",
				"Content-Type": "text/html",
			}),
		}),
	};
	const formatter = new NetworkFormatter(request, {
		requestId: 1,
		redactNetworkHeaders: true,
	});
	for (const output of [
		formatter.toStringDetailed(),
		JSON.stringify(formatter.toJSONDetailed()),
	]) {
		expect(output).not.toMatch(
			/qa-cookie-secret|qa-auth-secret|qa-response-secret/,
		);
		expect(output).toContain("text/html");
	}
});
