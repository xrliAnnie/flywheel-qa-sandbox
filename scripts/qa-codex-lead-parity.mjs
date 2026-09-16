#!/usr/bin/env node
import { createHash } from "node:crypto";
// FLY-2519: installed-input inventory only. Never starts providers or calls tools.
import {
	accessSync,
	constants,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const names = [
	"runner actions",
	"Discord inbound and threads",
	"Discord history",
	"Discord rich actions",
	"Linear",
	"GitHub and git",
	"Bridge and comm",
	"terminal",
	"inbox receipts",
	"patrol",
	"reports",
	"browser",
	"rules",
	"persona and skills",
	"gbrain",
	"Xiaohongshu",
	"other integrations",
];
const validName = (value) =>
	typeof value === "string" && /^[a-zA-Z0-9_@./-]{1,128}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function read(path) {
	try {
		if (statSync(path).size > 4 * 1024 * 1024) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
function json(path) {
	try {
		return JSON.parse(read(path));
	} catch {
		return null;
	}
}
function entries(path) {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}
function source(path) {
	const content = read(path);
	return {
		path,
		status: content === null ? "missing_or_unreadable" : "observed",
		sha256: content === null ? null : digest(content),
	};
}
function skills(root) {
	return entries(root)
		.filter(validName)
		.flatMap((name) => {
			const entry = source(join(root, name, "SKILL.md"));
			return entry.status === "observed" ? [{ name, ...entry }] : [];
		});
}
function servers(path, toml = false) {
	const content = read(path);
	let keys = [];
	if (toml)
		keys = [
			...(content ?? "").matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm),
		].map((m) => m[1]);
	else keys = Object.keys(json(path)?.mcpServers ?? {});
	return [...new Set(keys)]
		.filter(validName)
		.sort()
		.map((name) => ({
			name,
			path,
			evidence: "configured_server_only",
			tools: null,
			toolSchemaDigest: null,
		}));
}
function cli(name, pathEnv) {
	for (const dir of pathEnv.split(":").filter(Boolean)) {
		const path = resolve(dir, name);
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile())
				return { name, path, status: "installed_execution_unverified" };
		} catch {}
	}
	return { name, path: null, status: "missing" };
}
function declaredTools(path) {
	const content = read(path);
	if (content === null) return [];
	const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true),
		out = [];
	const add = (name, node, schema) => {
		if (validName(name))
			out.push({
				name,
				source: path,
				line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
				evidence: "source_declaration_only",
				toolSchemaDigest: null,
				schemaSourceDigest: schema ? digest(schema.getText(file)) : null,
			});
	};
	const visit = (node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			["tool", "registerTool"].includes(node.expression.name.text) &&
			node.arguments[0] &&
			ts.isStringLiteral(node.arguments[0])
		)
			add(node.arguments[0].text, node, node.arguments[2]);
		if (ts.isObjectLiteralExpression(node)) {
			const fields = node.properties.filter(ts.isPropertyAssignment);
			const schema = fields.find((p) => p.name.getText(file) === "inputSchema");
			const name = fields.find((p) => p.name.getText(file) === "name");
			if (schema && name && ts.isStringLiteral(name.initializer))
				add(name.initializer.text, node, schema.initializer);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return out;
}
// Static declarations are not tools/list, effective authorization, or a live route probe.
export function inventorySource(repo) {
	const base = join(repo, "packages/teamlead/src/bridge");
	const scan = (dir) =>
		entries(dir)
			.filter((n) => n !== "__tests__")
			.flatMap((n) => {
				const path = join(dir, n);
				try {
					return statSync(path).isDirectory()
						? scan(path)
						: n.endsWith(".ts")
							? [path]
							: [];
				} catch {
					return [];
				}
			});
	const files = scan(base);
	const routes = [],
		mounts = [],
		tools = [],
		commCommands = [];
	const guards = (node) => {
		const result = new Set();
		const walk = (n) => {
			if (
				ts.isIdentifier(n) &&
				/(auth|guard|claim|lease|founder|scope|capability|permission|token)/i.test(
					n.text,
				)
			)
				result.add(n.text);
			ts.forEachChild(n, walk);
		};
		walk(node);
		return [...result].sort();
	};
	const parse = (path) =>
		ts.createSourceFile(path, read(path) ?? "", ts.ScriptTarget.Latest, true);
	const aliases = new Map();
	for (const path of files) {
		const file = parse(path);
		const visit = (node) => {
			if (
				(ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
				node.initializer &&
				ts.isCallExpression(node.initializer) &&
				node.name
			) {
				aliases.set(
					node.name.getText(file),
					node.initializer.expression.getText(file),
				);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	const factoryOf = (node) => {
		const name = ts.isCallExpression(node)
			? node.expression.getText()
			: node.getText();
		return aliases.get(name) ?? aliases.get(name.split(".").at(-1)) ?? name;
	};
	for (const path of files) {
		const file = parse(path);
		const visit = (node, factory = null) => {
			if (ts.isFunctionDeclaration(node) && node.name) factory = node.name.text;
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression)
			) {
				const method = node.expression.name.text;
				const owner = node.expression.expression.getText(file);
				const first = node.arguments[0];
				if (
					first &&
					ts.isStringLiteral(first) &&
					/(app|router)$/i.test(owner)
				) {
					const line =
						file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
					if (method === "use") {
						const factories = node.arguments
							.slice(1)
							.map(factoryOf)
							.filter(validName);
						mounts.push({
							path: first.text,
							factories,
							guardSymbols: guards(node),
							source: path,
							line,
						});
					}
					if (
						[
							"get",
							"post",
							"put",
							"patch",
							"delete",
							"head",
							"options",
						].includes(method)
					)
						routes.push({
							method: method.toUpperCase(),
							localPath: first.text,
							factory,
							source: path,
							line,
							guardSymbols: guards(node),
						});
				}
			}
			ts.forEachChild(node, (n) => visit(n, factory));
		};
		visit(file);
	}
	for (const route of routes) {
		const matched = mounts.filter((m) => m.factories.includes(route.factory));
		route.mounts = [...new Set(matched.map((m) => m.path))];
		route.path =
			route.mounts.length === 1
				? `${route.mounts[0]}${route.localPath === "/" ? "" : route.localPath}`
				: route.localPath;
		route.mountGuardSymbols = [
			...new Set(matched.flatMap((m) => m.guardSymbols)),
		].sort();
		route.classification =
			/(^|\/)(ship[^/]*|merge[^/]*|close[^/]*|terminate|restart|lifecycle[^/]*)(\/|$)/i.test(
				route.path,
			)
				? "reserved"
				: ["GET", "HEAD", "OPTIONS"].includes(route.method)
					? "read_candidate"
					: "write_candidate";
		route.authorizationVerified = false;
	}
	for (const relative of [
		"packages/terminal-mcp/src/index.ts",
		"packages/inbox-mcp/src/index.ts",
	]) {
		tools.push(...declaredTools(join(repo, relative)));
	}

	const commPath = join(repo, "packages/flywheel-comm/src/index.ts"),
		comm = parse(commPath);
	const visitComm = (node) => {
		if (
			ts.isSwitchStatement(node) &&
			node.expression.getText(comm) === "command"
		)
			for (const clause of node.caseBlock.clauses)
				if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression))
					commCommands.push({
						name: clause.expression.text,
						source: commPath,
						line:
							comm.getLineAndCharacterOfPosition(clause.getStart(comm)).line +
							1,
					});
		ts.forEachChild(node, visitComm);
	};
	visitComm(comm);
	return {
		evidence: "source_declarations_not_runtime",
		routes,
		mounts,
		tools,
		commCommands,
	};
}
export function collectInventory({
	project,
	lead,
	home = homedir(),
	repo = resolve(fileURLToPath(new URL("..", import.meta.url))),
	claudeLead = "flywheel-eng-lead",
	pathEnv = process.env.PATH ?? "",
}) {
	for (const value of [project, lead, claudeLead])
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(value ?? ""))
			throw new Error("invalid_identity");
	const workspace = join(home, ".flywheel/lead-workspace", claudeLead);
	const codexHome = join(home, `.codex-${lead}`);
	const registry = json(join(home, ".claude/plugins/installed_plugins.json"));
	const plugins = Object.keys(registry?.plugins ?? {})
		.filter(validName)
		.sort()
		.map((name) => ({
			name,
			evidence: "installed_registry_only",
			sourceTools: (Array.isArray(registry.plugins[name])
				? registry.plugins[name]
				: []
			).flatMap((row) =>
				typeof row.installPath === "string"
					? declaredTools(join(row.installPath, "server.ts"))
					: [],
			),
			sourceSkills: (Array.isArray(registry.plugins[name])
				? registry.plugins[name]
				: []
			).flatMap((row) =>
				typeof row.installPath === "string"
					? skills(join(row.installPath, "skills"))
					: [],
			),
		}));
	const ruleDir = join(home, ".flywheel/lead-rules-bundles");
	const bundles = entries(ruleDir)
		.filter(
			(n) => n.startsWith(`${project}-${claudeLead}.`) && n.endsWith(".md"),
		)
		.map((n) => {
			const path = join(ruleDir, n);
			const body = read(path) ?? "";
			// Read only materializer MANIFEST header; never serialize rule/body text.
			const header = body.split("PROBE:")[0];
			const sources = [
				...header.matchAll(/^\s+\d+\. [^\n]+ — (\/[^\n]+)$/gm),
			].map((m) => source(m[1]));
			return {
				...source(path),
				sources,
				evidence: "materialized_bundle_not_active_session",
			};
		});
	const claude = {
		configStatus: json(join(workspace, ".mcp.json"))?.mcpServers
			? "observed"
			: "missing_or_invalid",
		servers: servers(join(workspace, ".mcp.json")),
		plugins,
		rules: bundles,
		skills: [
			...skills(join(home, ".claude/skills")),
			...skills(join(workspace, ".claude/skills")),
		],
	};
	const codex = {
		configStatus:
			read(join(codexHome, "config.toml")) === null
				? "missing_or_unreadable"
				: "observed_unparsed_toml",
		servers: servers(join(codexHome, "config.toml"), true),
		rules: [source(join(codexHome, "AGENTS.md"))],
		skills: skills(join(codexHome, "skills")),
	};
	return {
		schemaVersion: 1,
		mode: "inventory",
		project,
		lead,
		claudeLead,
		parityVerified: false,
		sourceInventory: inventorySource(repo),
		claude,
		codex,
		configuredServerDifference: {
			claudeOnly: claude.servers
				.map((s) => s.name)
				.filter((name) => !codex.servers.some((s) => s.name === name)),
			codexOnly: codex.servers
				.map((s) => s.name)
				.filter((name) => !claude.servers.some((s) => s.name === name)),
			evidence:
				claude.configStatus === "observed" &&
				codex.configStatus === "observed_unparsed_toml"
					? "names_only_not_capability_equivalence"
					: "incomplete_inputs",
		},
		cli: ["gh", "git", "node", "pnpm", "tmux"].map((name) =>
			cli(name, pathEnv),
		),
		repositorySources: [
			"packages/teamlead/scripts/claude-lead.sh",
			"packages/teamlead/scripts/codex-lead.sh",
			"packages/teamlead/scripts/lead-rules-bundle.sh",
			"scripts/lead-patrol-snapshot.sh",
			"packages/flywheel-comm/src/index.ts",
		].map((path) => source(join(repo, path))),
		rows: names.map((name, i) => ({
			id: `P${String(i + 1).padStart(2, "0")}`,
			name,
			status: "unverified",
		})),
		gaps: [
			"runtime_tools_list_missing",
			"active_rule_selection_unverified",
			"plugin_enablement_unverified",
			"role_applicability_unverified",
			"provider_permissions_unverified",
			"browser_drill_not_run",
		],
		notes: [
			"Installed and configured inputs are discovery evidence only; missing tools/list is not an empty tool set.",
			"No subprocess, provider request, credential output, process restart, or filesystem write is performed.",
		],
	};
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const { values } = parseArgs({
			options: {
				mode: { type: "string" },
				project: { type: "string" },
				lead: { type: "string" },
				home: { type: "string" },
				"claude-lead": { type: "string" },
			},
		});
		if (values.mode !== "inventory") throw new Error("unsupported_mode");
		process.stdout.write(
			`${JSON.stringify(collectInventory({ project: values.project, lead: values.lead, home: values.home, claudeLead: values["claude-lead"] }), null, 2)}\n`,
		);
	} catch {
		process.stderr.write(
			"Inventory rejected: require --mode inventory, valid --project and --lead, and supported options.\n",
		);
		process.exitCode = 2;
	}
}
