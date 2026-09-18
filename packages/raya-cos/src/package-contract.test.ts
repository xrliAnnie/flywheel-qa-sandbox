import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ModuleSpecifier {
	line: number;
	value: string;
}

function collectSpecifiers(text: string): ModuleSpecifier[] {
	const source = ts.createSourceFile(
		"source.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const found: ModuleSpecifier[] = [];
	const add = (node: ts.Expression | undefined): void => {
		if (!node || !ts.isStringLiteralLike(node)) return;
		found.push({
			line:
				source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
			value: node.text,
		});
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			add(node.moduleSpecifier);
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			add(node.moduleReference.expression);
		else if (ts.isCallExpression(node)) {
			const isRequire =
				ts.isIdentifier(node.expression) && node.expression.text === "require";
			const isDynamicImport =
				node.expression.kind === ts.SyntaxKind.ImportKeyword;
			if (isRequire || isDynamicImport) add(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("flywheel-raya-cos package contract", () => {
	it("has the pinned private package identity", () => {
		expect(manifest).toMatchObject({
			name: "flywheel-raya-cos",
			private: true,
			type: "module",
			exports: "./dist/index.js",
			bin: { "raya-cos": "./dist/cli.js" },
		});
	});

	it("is discoverable by the light shard and package gate", () => {
		expect(manifest.scripts["test:run"]).toBe("vitest run");
		expect(manifest.scripts.build).toBeTruthy();
		expect(manifest.scripts.typecheck).toBeTruthy();
	});

	it("declares no runtime dependencies", () => {
		expect("dependencies" in manifest).toBe(false);
		expect("peerDependencies" in manifest).toBe(false);
		expect("optionalDependencies" in manifest).toBe(false);
		expect(Object.keys(manifest.devDependencies).sort()).toEqual([
			"@types/node",
			"typescript",
			"vitest",
		]);
	});

	it("imports only local files and Node built-ins", () => {
		const sourceDir = join(packageRoot, "src");
		const violations = readdirSync(sourceDir, { recursive: true })
			.filter(
				(path): path is string =>
					typeof path === "string" &&
					path.endsWith(".ts") &&
					!path.endsWith(".test.ts"),
			)
			.flatMap((path) =>
				collectSpecifiers(readFileSync(join(sourceDir, path), "utf8"))
					.filter(
						({ value }) =>
							!value.startsWith("./") &&
							!value.startsWith("../") &&
							!value.startsWith("node:"),
					)
					.map(({ line, value }) => `${path}:${line} ${value}`),
			);
		expect(violations).toEqual([]);
	});

	it("proves the source dependency guard catches supported import forms", () => {
		const violations = collectSpecifiers(
			'import "left-pad";\nconst x = require("left-pad");\nimport lp = require("left-pad");',
		)
			.map(({ value }) => value)
			.filter(
				(value) =>
					!value.startsWith("./") &&
					!value.startsWith("../") &&
					!value.startsWith("node:"),
			);
		expect(violations).toEqual(["left-pad", "left-pad", "left-pad"]);
		expect(
			collectSpecifiers(
				'import { a } from "./a.js";\nimport { b } from "node:fs";',
			).map(({ value }) => value),
		).toEqual(["./a.js", "node:fs"]);
	});

	it("keeps noUncheckedIndexedAccess as the single package override", () => {
		const config = JSON.parse(
			readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
		);
		const base = JSON.parse(
			readFileSync(
				new URL("../../../tsconfig.base.json", import.meta.url),
				"utf8",
			),
		);
		expect(config.extends).toBe("../../tsconfig.base.json");
		expect(Object.keys(config.compilerOptions).sort()).toEqual([
			"module",
			"moduleResolution",
			"noUncheckedIndexedAccess",
			"outDir",
			"rootDir",
		]);
		expect(config.compilerOptions).toEqual({
			rootDir: "src",
			outDir: "dist",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			noUncheckedIndexedAccess: false,
		});
		expect(config.include).toEqual(["src/**/*.ts"]);
		expect(config.exclude).toEqual(["src/**/*.test.ts"]);
		expect(base.compilerOptions.noUncheckedIndexedAccess).toBe(true);
	});

	it("stays outside the packaged customer payload", () => {
		const source = readFileSync(
			join(repoRoot, "scripts/package-onboard.sh"),
			"utf8",
		);
		const assignments = source.match(/^PO_PACKAGES=.*$/gm) ?? [];
		expect(assignments).toHaveLength(1);
		expect(assignments[0]?.endsWith("\\")).toBe(false);
		const match = assignments[0]?.match(
			/^PO_PACKAGES=\$\{PO_PACKAGES:-"([^"]*)"\}$/,
		);
		expect(match).not.toBeNull();
		expect(match?.[1]?.split(/\s+/)).not.toContain("raya-cos");
	});
});
