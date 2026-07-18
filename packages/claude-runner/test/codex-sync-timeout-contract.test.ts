import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
	"../src/codex-runner-tui-window.ts",
	"../src/CodexTmuxAdapter.ts",
	"../src/codex-daemon-runtime.ts",
];

function propertyNumber(
	object: ts.ObjectLiteralExpression | undefined,
	name: string,
): number | undefined {
	if (!object) return undefined;
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		if (property.name.getText() !== name) continue;
		if (!ts.isNumericLiteral(property.initializer)) return undefined;
		return Number(property.initializer.text);
	}
	return undefined;
}

describe("FLY-1365 codex-path synchronous timeout contract", () => {
	it("bounds every literal spawnSync/execFileSync call to at most 10 seconds", () => {
		const violations: string[] = [];
		for (const relative of SOURCE_FILES) {
			const path = fileURLToPath(new URL(relative, import.meta.url));
			const source = ts.createSourceFile(
				path,
				readFileSync(path, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node)) {
					const callee = node.expression.getText(source);
					if (callee === "spawnSync" || callee === "execFileSync") {
						const options =
							node.arguments[2] &&
							ts.isObjectLiteralExpression(node.arguments[2])
								? node.arguments[2]
								: undefined;
						const timeout = propertyNumber(options, "timeout");
						if (timeout === undefined || timeout > 10_000) {
							const line =
								source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
							violations.push(
								`${relative}:${line} ${callee} timeout=${timeout}`,
							);
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
		expect(violations).toEqual([]);
	});

	it("requires every CodexTmuxAdapter execFileFn call to declare timeoutMs <=10s", () => {
		const relative = "../src/CodexTmuxAdapter.ts";
		const path = fileURLToPath(new URL(relative, import.meta.url));
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const violations: string[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.getText(source) === "this" &&
				node.expression.name.text === "execFileFn"
			) {
				const options =
					node.arguments[2] && ts.isObjectLiteralExpression(node.arguments[2])
						? node.arguments[2]
						: undefined;
				const timeout = propertyNumber(options, "timeoutMs");
				if (timeout === undefined || timeout > 10_000) {
					const line =
						source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
					violations.push(`${relative}:${line} timeoutMs=${timeout}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		expect(violations).toEqual([]);
	});
});
