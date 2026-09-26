import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CLOCK_AUDIT_MARKER = "wall-clock-audit: deterministic-clock";
const OBSERVATION_BUDGET_EXACT_ASSERTION_TESTS = [
	"packages/teamlead/src/ship-judgment/__tests__/outcomes.test.ts",
	"packages/teamlead/src/ship-judgment/__tests__/verdict-cursor.test.ts",
] as const;

function trackedFiles(): string[] {
	return execFileSync("git", ["ls-files"], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\n")
		.filter(Boolean);
}

function packageTestFiles(files: readonly string[]): string[] {
	return files.filter(
		(file) =>
			file.startsWith("packages/") &&
			/(?:^|\/)(?:__tests__|test)\//.test(file) &&
			/\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/.test(file),
	);
}

function ciScriptFiles(files: readonly string[]): string[] {
	const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
	const tracked = new Set(files);
	const scripts = new Set<string>();
	for (const match of ci.matchAll(
		/(?:^|\s)((?:scripts|packages\/[^/]+\/scripts)\/[A-Za-z0-9_./*-]+\.(?:sh|mjs))\b/g,
	)) {
		const pattern = match[1]!;
		if (!pattern.includes("*")) {
			if (tracked.has(pattern)) scripts.add(pattern);
			continue;
		}
		const matcher = new RegExp(
			`^${pattern
				.split("*")
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("[^/]*")}$`,
		);
		for (const file of files) if (matcher.test(file)) scripts.add(file);
	}
	// `pnpm test:cycle-time` resolves this package.json glob rather than spelling
	// each test in ci.yml. Keep command resolution tied to the CI invocation.
	if (/\bpnpm test:cycle-time\b/.test(ci)) {
		for (const file of files) {
			if (/^scripts\/cycle-time\/__tests__\/[^/]+\.test\.mjs$/.test(file))
				scripts.add(file);
		}
	}
	return [...scripts].sort();
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
	return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function hasAuditMarker(text: string, line: number): boolean {
	const lines = text.split(/\r?\n/);
	return lines
		.slice(Math.max(0, line - 3), line)
		.some((candidate) => candidate.includes(CLOCK_AUDIT_MARKER));
}

function isClockCall(node: ts.Node): boolean {
	if (!ts.isCallExpression(node)) return false;
	const callee = node.expression.getText();
	return (
		callee === "Date.now" ||
		callee === "performance.now" ||
		callee === "process.hrtime" ||
		callee === "process.hrtime.bigint"
	);
}

function contains(
	node: ts.Node | undefined,
	predicate: (candidate: ts.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	let found = false;
	node.forEachChild((child) => {
		if (!found && contains(child, predicate)) found = true;
	});
	return found;
}

function baseIdentifier(node: ts.Expression): ts.Identifier | undefined {
	if (ts.isIdentifier(node)) return node;
	if (
		ts.isPropertyAccessExpression(node) ||
		ts.isElementAccessExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isParenthesizedExpression(node)
	)
		return baseIdentifier(node.expression);
	return undefined;
}

function packageViolations(file: string): string[] {
	const text = readFileSync(join(ROOT, file), "utf8");
	if (
		!/(?:Date\.now|performance\.now|process\.hrtime|durationMs|elapsedMs|wallMs|samples?)/.test(
			text,
		)
	)
		return [];
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".ts") || file.endsWith(".tsx")
			? ts.ScriptKind.TS
			: ts.ScriptKind.JS,
	);
	const clockPoints = new Set<string>();
	const durations = new Set<string>();
	const durationArrays = new Set<string>();
	const declarations: ts.VariableDeclaration[] = [];
	const assignments: ts.BinaryExpression[] = [];
	const pushes: ts.CallExpression[] = [];
	const calls: ts.CallExpression[] = [];
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
			declarations.push(node);
		if (ts.isCallExpression(node)) {
			calls.push(node);
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "push"
			)
				pushes.push(node);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left)
		)
			assignments.push(node);
		ts.forEachChild(node, collect);
	};
	collect(source);

	const hasClockPoint = (node: ts.Node | undefined): boolean =>
		contains(
			node,
			(candidate) =>
				isClockCall(candidate) ||
				(ts.isIdentifier(candidate) && clockPoints.has(candidate.text)),
		);
	const isDuration = (node: ts.Node | undefined): boolean => {
		if (!node) return false;
		if (ts.isIdentifier(node)) return durations.has(node.text);
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.MinusToken &&
			(hasClockPoint(node.left) || hasClockPoint(node.right))
		)
			return true;
		if (ts.isBinaryExpression(node))
			return isDuration(node.left) || isDuration(node.right);
		if (ts.isElementAccessExpression(node)) {
			const base = baseIdentifier(node.expression);
			return Boolean(base && durationArrays.has(base.text));
		}
		if (ts.isCallExpression(node))
			return node.arguments.some((argument) => isDuration(argument));
		if (ts.isSpreadElement(node)) return isDuration(node.expression);
		if (
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isPrefixUnaryExpression(node)
		)
			return isDuration(node.expression);
		return false;
	};

	let changed = true;
	while (changed) {
		changed = false;
		for (const declaration of declarations) {
			const name = (declaration.name as ts.Identifier).text;
			if (
				!clockPoints.has(name) &&
				contains(declaration.initializer, isClockCall)
			) {
				clockPoints.add(name);
				changed = true;
			}
			if (!durations.has(name) && isDuration(declaration.initializer)) {
				durations.add(name);
				changed = true;
			}
		}
		for (const assignment of assignments) {
			const name = (assignment.left as ts.Identifier).text;
			if (!clockPoints.has(name) && contains(assignment.right, isClockCall)) {
				clockPoints.add(name);
				changed = true;
			}
			if (!durations.has(name) && isDuration(assignment.right)) {
				durations.add(name);
				changed = true;
			}
		}
		for (const push of pushes) {
			const target = (push.expression as ts.PropertyAccessExpression)
				.expression;
			const identifier = baseIdentifier(target);
			if (
				identifier &&
				!durationArrays.has(identifier.text) &&
				push.arguments.some((argument) => isDuration(argument))
			) {
				durationArrays.add(identifier.text);
				changed = true;
			}
		}
	}

	const isDurationProperty = (node: ts.Node | undefined): boolean =>
		contains(
			node,
			(candidate) =>
				ts.isPropertyAccessExpression(candidate) &&
				/(?:duration|elapsed|wall)Ms$/i.test(candidate.name.text),
		);
	const tainted = (node: ts.Node | undefined): boolean =>
		isDuration(node) || isDurationProperty(node);
	const violations: string[] = [];
	const add = (node: ts.Node, reason: string) => {
		const line = lineOf(source, node);
		if (!hasAuditMarker(text, line))
			violations.push(`${file}:${line} ${reason}`);
	};

	for (const call of calls) {
		if (!ts.isPropertyAccessExpression(call.expression)) continue;
		const matcher = call.expression.name.text;
		const expectCall = call.expression.expression;
		if (
			!ts.isCallExpression(expectCall) ||
			expectCall.expression.getText(source) !== "expect"
		)
			continue;
		const subject = expectCall.arguments[0];
		const bound = call.arguments[0];
		if (
			(matcher === "toBeLessThan" || matcher === "toBeLessThanOrEqual") &&
			(tainted(subject) || tainted(bound))
		) {
			add(call, "real duration has an absolute upper bound");
		}
		if (
			(matcher === "toBeGreaterThan" || matcher === "toBeGreaterThanOrEqual") &&
			tainted(bound)
		) {
			add(call, "real duration is the upper side of an absolute comparison");
		}
		if (
			matcher === "toBe" &&
			bound?.kind === ts.SyntaxKind.TrueKeyword &&
			subject &&
			ts.isBinaryExpression(subject)
		) {
			if (
				(subject.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
					subject.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) &&
				tainted(subject.left)
			)
				add(
					call,
					"boolean assertion gives a real duration an absolute upper bound",
				);
			if (
				(subject.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
					subject.operatorToken.kind ===
						ts.SyntaxKind.GreaterThanEqualsToken) &&
				tainted(subject.right)
			)
				add(
					call,
					"boolean assertion gives a real duration an absolute upper bound",
				);
		}
	}

	for (const call of calls) {
		const callee = call.expression.getText(source);
		if (callee !== "assert" && callee !== "assert.ok") continue;
		const condition = call.arguments[0];
		if (!condition || !ts.isBinaryExpression(condition)) continue;
		if (
			(condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
				condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) &&
			tainted(condition.left)
		)
			add(call, "assert gives a real duration an absolute upper bound");
		if (
			(condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
				condition.operatorToken.kind ===
					ts.SyntaxKind.GreaterThanEqualsToken) &&
			tainted(condition.right)
		)
			add(call, "assert gives a real duration an absolute upper bound");
	}

	return violations;
}

function scriptViolations(file: string): string[] {
	const text = readFileSync(join(ROOT, file), "utf8");
	if (
		!/(?:elapsed|wall|SECONDS|date \+%s|time\.(?:monotonic|perf_counter))/i.test(
			text,
		)
	)
		return [];
	const lines = text.split(/\r?\n/);
	const violations: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (/^\s*#/.test(line)) continue;
		if (
			/(?:elapsed|wall)[A-Za-z0-9_]*"?\s+(?:-lt|-le)\s+\d+/i.test(line) ||
			/(?:elapsed|wall)[A-Za-z0-9_.]*\s*(?:<|<=)\s*\d+/i.test(line)
		) {
			if (!hasAuditMarker(text, index + 1))
				violations.push(
					`${file}:${index + 1} real duration has an absolute upper bound`,
				);
		}
	}
	return violations;
}

function observationBudgetViolations(): string[] {
	const violations: string[] = [];
	for (const file of OBSERVATION_BUDGET_EXACT_ASSERTION_TESTS) {
		const text = readFileSync(join(ROOT, file), "utf8");
		const observes = text.search(/\.observe(?:Cancellations|Verdicts)\s*\(/);
		const injectsClock =
			/vi\.spyOn\(\s*performance\s*,\s*["']now["']\s*\)[\s\S]{0,120}\.mock(?:ReturnValue|Implementation)\s*\(/.test(
				text,
			);
		if (!injectsClock) {
			const line =
				observes < 0 ? 1 : text.slice(0, observes).split(/\r?\n/).length;
			violations.push(
				`${file}:${line} exact observation-budget assertions require an injected performance.now clock`,
			);
		}
	}
	return violations;
}

it("keeps real wall-clock upper bounds out of every required check", () => {
	const files = trackedFiles();
	const packageFiles = packageTestFiles(files);
	const scriptFiles = ciScriptFiles(files);
	const violations = [
		...observationBudgetViolations(),
		...packageFiles.flatMap(packageViolations),
		...scriptFiles.flatMap(scriptViolations),
	].sort();
	expect(
		violations,
		`Required tests must assert fake time, operation counts, or state instead of host duration:\n${violations.join("\n")}`,
	).toEqual([]);
}, 60_000);
