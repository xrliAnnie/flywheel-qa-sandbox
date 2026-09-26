import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REPOSITORY_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function trackedSourceFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z"], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: REPOSITORY_LIST_MAX_BUFFER,
	})
		.split("\0")
		.filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file));
}

function staticText(node: ts.Expression): string | undefined {
	return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isWholeRepositoryListing(call: ts.CallExpression): boolean {
	if (!ts.isIdentifier(call.expression)) return false;
	if (!["execFile", "execFileSync", "spawnSync"].includes(call.expression.text))
		return false;
	const command = call.arguments[0];
	const argv = call.arguments[1];
	if (!command || staticText(command) === undefined || !argv) return false;
	if (
		basename(staticText(command)!) !== "git" ||
		!ts.isArrayLiteralExpression(argv)
	)
		return false;

	const values = argv.elements.map((element) =>
		ts.isSpreadElement(element) ? undefined : staticText(element),
	);
	const commandIndex = values.findIndex(
		(value) => value === "ls-files" || value === "ls-tree",
	);
	if (commandIndex < 0) return false;
	const subcommand = values[commandIndex];
	const tail = values.slice(commandIndex + 1);
	const separator = tail.indexOf("--");
	if (separator >= 0 && separator < tail.length - 1) return false;

	if (subcommand === "ls-files") {
		return !tail.some((value) => value === undefined || !value.startsWith("-"));
	}

	const positional = tail.filter(
		(value): value is string => value !== undefined && !value.startsWith("-"),
	);
	return positional.length <= 1;
}

function hasExplicitMaxBuffer(call: ts.CallExpression): boolean {
	const options = call.arguments[2];
	return (
		options !== undefined &&
		ts.isObjectLiteralExpression(options) &&
		options.properties.some(
			(property) =>
				ts.isPropertyAssignment(property) &&
				property.name.getText() === "maxBuffer",
		)
	);
}

it("gives whole-repository git listings an explicit output buffer", () => {
	const violations: string[] = [];
	for (const file of trackedSourceFiles()) {
		const text = readFileSync(join(ROOT, file), "utf8");
		if (!/\b(?:ls-files|ls-tree)\b/.test(text)) continue;
		const source = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".ts") || file.endsWith(".tsx")
				? ts.ScriptKind.TS
				: ts.ScriptKind.JS,
		);
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				isWholeRepositoryListing(node) &&
				!hasExplicitMaxBuffer(node)
			) {
				const line =
					source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
				violations.push(`${file}:${line}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	expect(violations).toEqual([]);
});
