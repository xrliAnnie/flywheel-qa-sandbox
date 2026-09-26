#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value || value.startsWith("--")) {
			throw new Error(`invalid argument near ${key ?? "end"}`);
		}
		values[key.slice(2)] = value;
	}
	return values;
}

function required(values, key) {
	const value = values[key]?.trim();
	if (!value) throw new Error(`--${key} is required`);
	return value;
}

function within(root, file) {
	const rel = relative(root, file);
	return (
		rel !== ".." &&
		!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(rel)
	);
}

async function main() {
	const values = parseArgs(process.argv.slice(2));
	const projectRoot = resolve(required(values, "root"));
	const flywheelRoot = resolve(required(values, "flywheel-root"));
	const agent = required(values, "agent");
	const configUrl = pathToFileURL(
		join(flywheelRoot, "packages/config/dist/index.js"),
	).href;
	const edgeUrl = pathToFileURL(
		join(flywheelRoot, "packages/edge-worker/dist/index.js"),
	).href;
	const configModule = await import(configUrl);
	const { AgentDispatcher } = await import(edgeUrl);
	const loader = new configModule.ConfigLoader((path) =>
		readFile(path, "utf8"),
	);
	const config = await loader.load(join(projectRoot, ".flywheel/config.yaml"));
	const bundled = configModule.loadBundledRegistry(
		join(flywheelRoot, ".flywheel/agents/registry.yaml"),
	);
	const projectRegistry = configModule.resolveProjectRegistry({
		bundled,
		projectName: config.project,
		projectRoot,
	});
	const agents = configModule.resolveAgentConfigs(
		config.agents ?? {},
		projectRegistry,
	);
	const flywheelRegistry = configModule.resolveProjectRegistry({
		bundled,
		projectName: "flywheel",
		projectRoot: flywheelRoot,
	});
	const fallbacks = configModule.resolveAgentConfigs(
		{
			generic: { node: "general", match: { labels: [] } },
			qa: { node: "qa", match: { labels: [] } },
		},
		flywheelRegistry,
	);
	const dispatcher = new AgentDispatcher(agents, config.default_agent, {
		generic: fallbacks.generic,
		qa: fallbacks.qa,
	});
	const result = dispatcher.dispatchByName(agent);
	const expected = join(projectRoot, ".flywheel/agents/nodes", `${agent}.md`);
	if (
		result.agentName !== agent ||
		result.matchMethod !== "override" ||
		resolve(result.agentConfig.agentFile) !== expected ||
		!within(join(projectRoot, ".flywheel/agents"), expected)
	) {
		throw new Error(
			`dispatch mismatch: ${JSON.stringify({ agentName: result.agentName, matchMethod: result.matchMethod, agentFile: result.agentConfig.agentFile, expected })}`,
		);
	}
	process.stdout.write(
		`${JSON.stringify({ success: true, agent, node: result.agentConfig.nodeName, agentFile: expected })}\n`,
	);
}

main().catch((error) => {
	process.stderr.write(`[qa-test-discipline-config] ${error.message}\n`);
	process.exitCode = 1;
});
