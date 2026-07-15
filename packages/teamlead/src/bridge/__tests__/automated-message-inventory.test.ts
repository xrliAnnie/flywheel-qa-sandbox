import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(process.cwd(), "src");

function productionTsFiles(dir = srcRoot): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : productionTsFiles(path);
		}
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
			? [path]
			: [];
	});
}

function rel(path: string): string {
	return relative(srcRoot, path).replaceAll("\\", "/");
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}

function propertyText(
	object: ts.ObjectLiteralExpression,
	name: string,
	source: ts.SourceFile,
): string | undefined {
	const property = object.properties.find(
		(candidate): candidate is ts.PropertyAssignment =>
			ts.isPropertyAssignment(candidate) &&
			candidate.name.getText(source) === name,
	);
	return property?.initializer.getText(source);
}

describe("automated Discord sender inventory", () => {
	it("classifies every shared sender reference with semantic origin", () => {
		const refs: string[] = [];
		for (const path of productionTsFiles()) {
			const sourceText = readFileSync(path, "utf8");
			const source = ts.createSourceFile(
				path,
				sourceText,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);
			let found = false;
			walk(source, (node) => {
				if (
					ts.isIdentifier(node) &&
					node.text === "postDiscordMessageToChannel"
				) {
					found = true;
				}
			});
			const file = rel(path);
			if (found && file !== "bridge/discord-utils.ts") refs.push(file);
		}

		expect(refs.sort()).toEqual([
			"bridge/auto-qa-effects.ts",
			"bridge/gate-poller.ts",
			"bridge/infra-notify.ts",
			"bridge/reports-route.ts",
			"bridge/tools.ts",
			"lead-backends/codex/DirectDiscordOutboundSender.ts",
			"lead-backends/codex/discord-send-core.ts",
			"lead-backends/codex/leadDiscordSend.ts",
		]);

		const authored = new Set([
			"bridge/tools.ts",
			"lead-backends/codex/DirectDiscordOutboundSender.ts",
			"lead-backends/codex/discord-send-core.ts",
			"lead-backends/codex/leadDiscordSend.ts",
		]);
		for (const file of refs) {
			const source = readFileSync(resolve(srcRoot, file), "utf8");
			expect(source, file).toContain(
				authored.has(file) ? 'origin: "lead_authored"' : 'origin: "automation"',
			);
		}
		expect([...authored].sort()).toHaveLength(4);
	});

	it("marks every direct text POST/PATCH sender", () => {
		const rawMessageFiles = new Set<string>();
		for (const path of productionTsFiles()) {
			const sourceText = readFileSync(path, "utf8");
			const source = ts.createSourceFile(
				path,
				sourceText,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);
			walk(source, (node) => {
				if (!ts.isCallExpression(node) || node.arguments.length < 2) return;
				const url = node.arguments[0].getText(source);
				if (
					!url.includes("/channels/") ||
					!url.includes("/messages") ||
					url.includes("/threads") ||
					url.includes("/reactions") ||
					url.includes("/pins")
				)
					return;
				const init = node.arguments[1];
				if (!ts.isObjectLiteralExpression(init)) return;
				const method = propertyText(init, "method", source);
				if (method === '"POST"' || method === '"PATCH"') {
					rawMessageFiles.add(rel(path));
				}
			});
		}

		expect([...rawMessageFiles].sort()).toEqual([
			"LeadAlertNotifier.ts",
			"bridge/AlertChannelHub.ts",
			"bridge/ChatThreadCreator.ts",
			"bridge/discord-post-file.ts",
			"bridge/discord-utils.ts",
			"bridge/founder-thread-notifier.ts",
			"bridge/legacy-phase-thread-sweep.ts",
			"bridge/publish-broker/wire.ts",
			"bridge/roundtable/RoundtableThreadManager.ts",
			"bridge/runner-ready-to-close-notifier.ts",
			"bridge/standup-service.ts",
			"lead-backends/codex/gateway/gateway-main.ts",
		]);

		for (const file of rawMessageFiles) {
			if (file === "bridge/discord-utils.ts") continue;
			expect(readFileSync(resolve(srcRoot, file), "utf8"), file).toContain(
				"markAutomatedDiscordText",
			);
		}
	});
});
