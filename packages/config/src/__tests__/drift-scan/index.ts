import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import type { FlagExemption } from "../../feature-flags/exemptions.js";

const FLAG_NAME_RE = /^FLYWHEEL_[A-Z0-9_]+$/;
const BOOL_LITERAL = "(?:0|1|true|false)";

export interface ScanSource {
	file: string;
	text: string;
}

export interface CodeHit {
	name: string;
	file: string;
	form: string;
	start: number;
	end: number;
	code?: string;
	anchorSymbol?: string;
	anchorStart?: number;
	anchorEnd?: number;
}

export interface RegexCandidate extends CodeHit {}

export interface ScanResult {
	rawCodeHits: CodeHit[];
	regexCandidates: RegexCandidate[];
	diagnostics: string[];
}

export interface ReadSiteLike {
	file: string;
	symbol: string;
	pattern: "process.env" | "env-param" | "dynamic" | "config" | "delegated";
	timing: string;
	resolverModule?: string;
	resolverSymbol?: string;
	configAccess?: string;
}

const REGEX_PATTERNS = [
	/process\.env\.(FLYWHEEL_[A-Z0-9_]+)/g,
	/process\.env\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]/g,
	new RegExp(
		String.raw`\benv\.(FLYWHEEL_[A-Z0-9_]+)\s*(?:===|!==)\s*["']${BOOL_LITERAL}["']`,
		"g",
	),
	new RegExp(
		String.raw`\benv\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]\s*(?:===|!==)\s*["']${BOOL_LITERAL}["']`,
		"g",
	),
];

function scriptKind(file: string): ts.ScriptKind {
	return file.endsWith(".mjs") || file.endsWith(".js")
		? ts.ScriptKind.JS
		: ts.ScriptKind.TS;
}

function normalizeFile(path: string): string {
	return path.split("\\").join("/");
}

const DEFAULT_SCAN_EXCLUDED_DIRS = new Set([
	"__mocks__",
	"__tests__",
	"dist",
	"node_modules",
]);
const PACKAGE_SCAN_EXCLUDED_DIRS = new Set([
	...DEFAULT_SCAN_EXCLUDED_DIRS,
	"coverage",
	"e2e",
	"examples",
	"test-scripts",
]);

function walkFiles(
	dir: string,
	include: (file: string) => boolean,
	excludedDirs: ReadonlySet<string> = DEFAULT_SCAN_EXCLUDED_DIRS,
): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		if (excludedDirs.has(entry)) {
			continue;
		}
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...walkFiles(path, include, excludedDirs));
		} else if (include(path)) found.push(path);
	}
	return found;
}

function isTestInfrastructure(file: string): boolean {
	const normalized = normalizeFile(file);
	return (
		/\/vitest[.](?:config|setup)[.](?:js|mjs|ts)$/.test(normalized) ||
		/\/test\/(?:fixtures|setup)[.](?:js|mjs|ts)$/.test(normalized)
	);
}

function isProductionCode(file: string): boolean {
	return (
		(file.endsWith(".ts") || file.endsWith(".mjs") || file.endsWith(".js")) &&
		!/[.](?:spec|test)[.](?:js|mjs|ts)$/.test(file) &&
		!file.endsWith(".d.ts") &&
		!isTestInfrastructure(file)
	);
}

function isProductionScript(file: string): boolean {
	return (
		(isProductionCode(file) || file.endsWith(".sh")) &&
		!file.endsWith(".test.sh")
	);
}

export function collectProductionSources(repoRoot: string): ScanSource[] {
	const files: string[] = [];
	const packagesDir = join(repoRoot, "packages");
	if (existsSync(packagesDir)) {
		for (const packageName of readdirSync(packagesDir).sort()) {
			const packageRoot = join(packagesDir, packageName);
			if (!statSync(packageRoot).isDirectory()) continue;
			files.push(
				...walkFiles(
					packageRoot,
					isProductionScript,
					PACKAGE_SCAN_EXCLUDED_DIRS,
				),
			);
		}
	}
	files.push(...walkFiles(join(repoRoot, "scripts"), isProductionScript));
	return [...new Set(files)].sort().map((file) => ({
		file: normalizeFile(relative(repoRoot, file)),
		text: readFileSync(file, "utf8"),
	}));
}

export function findRegexCandidates(source: ScanSource): RegexCandidate[] {
	const candidates: RegexCandidate[] = [];
	for (const pattern of REGEX_PATTERNS) {
		pattern.lastIndex = 0;
		let match = pattern.exec(source.text);
		while (match) {
			candidates.push({
				name: match[1] as string,
				file: source.file,
				form: "regex-candidate",
				start: match.index,
				end: match.index + match[0].length,
			});
			match = pattern.exec(source.text);
		}
	}
	return candidates.filter(
		(candidate, index) =>
			candidates.findIndex(
				(other) =>
					other.name === candidate.name &&
					other.start === candidate.start &&
					other.end === candidate.end,
			) === index,
	);
}

function candidateStartsInTrivia(
	source: ScanSource,
	position: number,
): boolean {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		false,
		ts.LanguageVariant.Standard,
		source.text,
	);
	const trivia = new Set([
		ts.SyntaxKind.SingleLineCommentTrivia,
		ts.SyntaxKind.MultiLineCommentTrivia,
		ts.SyntaxKind.StringLiteral,
		ts.SyntaxKind.NoSubstitutionTemplateLiteral,
		ts.SyntaxKind.TemplateHead,
		ts.SyntaxKind.TemplateMiddle,
		ts.SyntaxKind.TemplateTail,
	]);
	let token = scanner.scan();
	while (token !== ts.SyntaxKind.EndOfFileToken) {
		if (scanner.getTokenPos() <= position && position < scanner.getTextPos()) {
			return trivia.has(token);
		}
		token = scanner.scan();
	}
	return false;
}

export function reconcileRegexCandidates(
	source: ScanSource,
	candidates: readonly RegexCandidate[],
	hits: readonly CodeHit[],
): string[] {
	return candidates
		.filter((candidate) => !candidateStartsInTrivia(source, candidate.start))
		.filter(
			(candidate) =>
				!hits.some(
					(hit) =>
						hit.file === candidate.file &&
						hit.name === candidate.name &&
						hit.start < candidate.end &&
						candidate.start < hit.end,
				),
		)
		.map(
			(candidate) =>
				`${candidate.file}: unmatched ${candidate.name} regex occurrence at ${candidate.start}`,
		);
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

function enclosingFunctionAnchor(
	node: ts.Node,
): { symbol: string; start: number; end: number } | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (
			(ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
			current.name &&
			ts.isIdentifier(current.name)
		) {
			return {
				symbol: current.name.text,
				start: current.getStart(),
				end: current.getEnd(),
			};
		}
		current = current.parent;
	}
	return undefined;
}

function addHit(
	hits: CodeHit[],
	source: ScanSource,
	name: string,
	form: string,
	node: ts.Node,
): void {
	if (!FLAG_NAME_RE.test(name)) return;
	const anchor = enclosingFunctionAnchor(node);
	const hit = {
		name,
		file: source.file,
		form,
		start: node.getStart(),
		end: node.getEnd(),
		code: source.text.slice(node.getStart(), node.getEnd()),
		...(anchor
			? {
					anchorSymbol: anchor.symbol,
					anchorStart: anchor.start,
					anchorEnd: anchor.end,
				}
			: {}),
	};
	if (
		!hits.some(
			(other) =>
				other.file === hit.file &&
				other.name === hit.name &&
				other.start === hit.start &&
				other.end === hit.end,
		)
	) {
		hits.push(hit);
	}
}

function isProcessEnv(node: ts.Expression | undefined): boolean {
	return Boolean(
		node &&
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "env" &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "process",
	);
}

function scanCode(source: ScanSource, parsed?: ts.SourceFile): ScanResult {
	tally(scanTally, source.file);
	const candidates = findRegexCandidates(source);
	const file = parsed ?? sourceFile(source);
	const parseDiagnostics = (
		file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
	).parseDiagnostics;
	if (!Array.isArray(parseDiagnostics)) {
		return {
			rawCodeHits: [],
			regexCandidates: candidates,
			diagnostics: [
				`${source.file}: parse error: TypeScript parser diagnostics unavailable`,
			],
		};
	}
	if (parseDiagnostics?.length) {
		return {
			rawCodeHits: [],
			regexCandidates: candidates,
			diagnostics: parseDiagnostics.map(
				(diagnostic) =>
					`${source.file}: parse error: ${diagnosticText(diagnostic)}`,
			),
		};
	}

	const stringKeys = new Map<string, string>();
	const gatherKeys = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isStringLiteralLike(node.initializer) &&
			FLAG_NAME_RE.test(node.initializer.text)
		) {
			stringKeys.set(node.name.text, node.initializer.text);
		}
		ts.forEachChild(node, gatherKeys);
	};
	gatherKeys(file);

	const hits: CodeHit[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node)) {
			addHit(hits, source, node.name.text, "property", node);
		}
		if (ts.isElementAccessExpression(node) && node.argumentExpression) {
			const argument = node.argumentExpression;
			if (ts.isStringLiteralLike(argument)) {
				addHit(hits, source, argument.text, "element", node);
			} else if (ts.isIdentifier(argument)) {
				const name = stringKeys.get(argument.text);
				if (name) addHit(hits, source, name, "const-key", node);
			}
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			isProcessEnv(node.initializer)
		) {
			for (const element of node.name.elements) {
				const property = element.propertyName ?? element.name;
				if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) {
					addHit(hits, source, property.text, "destructure", element);
				}
			}
		}
		if (ts.isCallExpression(node)) {
			for (const argument of node.arguments) {
				if (ts.isStringLiteralLike(argument)) {
					addHit(hits, source, argument.text, "helper-key", argument);
				} else if (ts.isIdentifier(argument)) {
					const name = stringKeys.get(argument.text);
					if (name) addHit(hits, source, name, "const-key", argument);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	return {
		rawCodeHits: hits,
		regexCandidates: candidates,
		diagnostics: reconcileRegexCandidates(source, candidates, hits),
	};
}

function shellMentions(line: string): Array<{ name: string; start: number }> {
	const found: Array<{ name: string; start: number }> = [];
	const pattern = /\$\{?(FLYWHEEL_[A-Z0-9_]+)/g;
	let match = pattern.exec(line);
	while (match) {
		found.push({ name: match[1] as string, start: match.index });
		match = pattern.exec(line);
	}
	return found;
}

function isShellConditional(line: string): boolean {
	return /(?:^\s*(?:if\b|elif\b|while\b|\[|\[\[|test\b)|&&\s*(?:\[|\[\[|test\b))/.test(
		line,
	);
}

function shellBoolComparison(line: string): boolean {
	return new RegExp(
		String.raw`(?:=|==|!=)\s*["']?${BOOL_LITERAL}["']?`,
		"i",
	).test(line);
}

function scanShell(source: ScanSource): ScanResult {
	tally(scanTally, source.file);
	const hits: CodeHit[] = [];
	const lines = source.text.split(/\r?\n/);
	let offset = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] as string;
		if (/^\s*#/.test(line)) {
			offset += line.length + 1;
			continue;
		}
		const mentions = shellMentions(line);
		for (const mention of mentions) {
			const node = {
				getStart: () => offset + mention.start,
				getEnd: () => offset + mention.start + mention.name.length,
			} as ts.Node;
			if (isShellConditional(line) && shellBoolComparison(line)) {
				addHit(hits, source, mention.name, "shell-comparison", node);
			}
			if (isShellConditional(line) && /\s-(?:n|z)\s/.test(line)) {
				addHit(hits, source, mention.name, "shell-presence", node);
			}
			if (
				isShellConditional(line) &&
				new RegExp(
					String.raw`\$\{${mention.name}:-${BOOL_LITERAL}\}`,
					"i",
				).test(line)
			) {
				addHit(hits, source, mention.name, "shell-bool-default", node);
			}
			if (
				new RegExp(
					String.raw`(?:^|\s)(?:local\s+)?[A-Za-z_][A-Za-z0-9_]*=["']?\$\{${mention.name}:-${BOOL_LITERAL}\}`,
					"i",
				).test(line)
			) {
				addHit(hits, source, mention.name, "shell-alias", node);
			}
			if (/^\s*case\b/.test(line)) {
				const body = lines.slice(index + 1, index + 12).join("\n");
				if (
					new RegExp(
						String.raw`(?:^\s*|\|)${BOOL_LITERAL}(?:\|${BOOL_LITERAL})*\)`,
						"im",
					).test(body)
				) {
					addHit(hits, source, mention.name, "shell-case", node);
				}
			}
		}
		offset += line.length + 1;
	}
	return { rawCodeHits: hits, regexCandidates: [], diagnostics: [] };
}

export function scanSources(sources: readonly ScanSource[]): ScanResult {
	const result: ScanResult = {
		rawCodeHits: [],
		regexCandidates: [],
		diagnostics: [],
	};
	for (const source of sources) {
		const scanned = source.file.endsWith(".sh")
			? scanShell(source)
			: scanCode(source);
		result.rawCodeHits.push(...scanned.rawCodeHits);
		result.regexCandidates.push(...scanned.regexCandidates);
		result.diagnostics.push(...scanned.diagnostics);
	}
	return result;
}

function isBooleanType(checker: ts.TypeChecker, type: ts.Type): boolean {
	const narrowed = checker.getNonNullableType(type);
	if (narrowed.isUnion()) {
		return narrowed.types.every(
			(member) =>
				(member.flags &
					(ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
				0,
		);
	}
	return (
		(narrowed.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
		0
	);
}

export function enumerateBooleanConfigPaths(typesFile: string): string[] {
	const program = ts.createProgram({
		rootNames: [typesFile],
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			noEmit: true,
			skipLibCheck: true,
		},
	});
	const checker = program.getTypeChecker();
	const file = program.getSourceFile(typesFile);
	if (!file) throw new Error(`cannot load config schema ${typesFile}`);
	const declaration = file.statements.find(
		(statement): statement is ts.InterfaceDeclaration =>
			ts.isInterfaceDeclaration(statement) &&
			statement.name.text === "FlywheelConfig",
	);
	if (!declaration) throw new Error("FlywheelConfig interface not found");
	const symbol = checker.getSymbolAtLocation(declaration.name);
	if (!symbol) throw new Error("FlywheelConfig symbol not found");

	const paths = new Set<string>();
	const visit = (type: ts.Type, path: string, depth: number): void => {
		if (depth > 12)
			throw new Error(`config schema recursion too deep at ${path}`);
		const narrowed = checker.getNonNullableType(type);
		if (isBooleanType(checker, narrowed)) {
			paths.add(path);
			return;
		}
		if (checker.isArrayType(narrowed) || checker.isTupleType(narrowed)) {
			const element = checker.getIndexTypeOfType(narrowed, ts.IndexKind.Number);
			if (element) visit(element, `${path}[]`, depth + 1);
			return;
		}
		const stringIndex = checker.getIndexTypeOfType(
			narrowed,
			ts.IndexKind.String,
		);
		if (stringIndex) visit(stringIndex, `${path}.*`, depth + 1);
		for (const property of checker.getPropertiesOfType(narrowed)) {
			const location = property.valueDeclaration ?? property.declarations?.[0];
			if (!location) continue;
			const propertyType = checker.getTypeOfSymbolAtLocation(
				property,
				location,
			);
			visit(
				propertyType,
				path ? `${path}.${property.name}` : property.name,
				depth + 1,
			);
		}
	};
	visit(checker.getDeclaredTypeOfSymbol(symbol), "", 0);
	return [...paths].sort();
}

export interface AuditFlagAccountsInput {
	rawCodeHits: readonly CodeHit[];
	configPaths: readonly string[];
	registeredEnvVars: ReadonlySet<string>;
	registeredConfigKeys: ReadonlySet<string>;
	nonFlagEnv: Readonly<Record<string, string>>;
	nonFlagConfigKeys: Readonly<Record<string, string>>;
	exemptions: readonly FlagExemption[];
	retiredEnvVars: ReadonlySet<string>;
	retiredConfigPaths: ReadonlySet<string>;
	storeManagedEnvVars: ReadonlySet<string>;
}

function isSkillModeCompatibilityRead(hit: CodeHit): boolean {
	return (
		hit.name === "FLYWHEEL_SKILL_FRAMEWORK_MODE" &&
		hit.file === "packages/config/src/skill-framework-mode.ts" &&
		hit.form === "const-key" &&
		hit.code === "args.env[SKILL_FRAMEWORK_MODE_ENV]" &&
		hit.anchorSymbol === "resolveSkillFrameworkMode" &&
		typeof hit.anchorStart === "number" &&
		typeof hit.anchorEnd === "number" &&
		hit.anchorStart <= hit.start &&
		hit.end <= hit.anchorEnd
	);
}

function duplicateValues(values: readonly string[]): string[] {
	return [
		...new Set(
			values.filter((value, index) => values.indexOf(value) !== index),
		),
	];
}

export function auditFlagAccounts(input: AuditFlagAccountsInput): string[] {
	const issues: string[] = [];
	const envNames = new Set(input.rawCodeHits.map((hit) => hit.name));
	const configPaths = new Set(input.configPaths);
	const envExemptions = new Set(
		input.exemptions
			.filter((entry) => entry.kind === "env")
			.map((entry) => entry.name),
	);
	const configExemptions = new Set(
		input.exemptions
			.filter((entry) => entry.kind === "config_key")
			.map((entry) => entry.name),
	);
	const retiredConfigRoot = (path: string): string | undefined =>
		[...input.retiredConfigPaths].find(
			(retired) => path === retired || path.startsWith(`${retired}.`),
		);
	const skillModeCompatibilityReads = input.rawCodeHits.filter(
		isSkillModeCompatibilityRead,
	);
	const allowedManagedRawRead =
		skillModeCompatibilityReads.length === 1
			? skillModeCompatibilityReads[0]
			: undefined;
	for (const hit of input.rawCodeHits) {
		if (
			input.storeManagedEnvVars.has(hit.name) &&
			hit !== allowedManagedRawRead
		) {
			issues.push(
				`${hit.name}: store-managed flag has raw production read at ${hit.file}:${hit.form}`,
			);
		}
	}

	for (const name of [...envNames].sort()) {
		if (input.retiredEnvVars.has(name)) {
			issues.push(`retired env flag ${name} has a production boolean read`);
		}
		if (
			!input.registeredEnvVars.has(name) &&
			!(name in input.nonFlagEnv) &&
			!envExemptions.has(name)
		) {
			issues.push(
				`${name}: register it, classify it in NON_FLAG_ALLOWLIST with a reason, or add an owned FLAG_EXEMPTION`,
			);
		}
	}
	for (const path of [...configPaths].sort()) {
		const retired = retiredConfigRoot(path);
		if (retired) {
			issues.push(
				`retired config path ${retired} has a boolean schema descendant ${path}`,
			);
		}
		if (
			!input.registeredConfigKeys.has(path) &&
			!(path in input.nonFlagConfigKeys) &&
			!configExemptions.has(path) &&
			!retired
		) {
			issues.push(
				`${path}: register this boolean config gate, classify it in NON_FLAG_CONFIG_KEYS with a reason, or add an owned FLAG_EXEMPTION`,
			);
		}
	}

	for (const [name, reason] of Object.entries(input.nonFlagEnv)) {
		if (!reason.trim())
			issues.push(`blank NON_FLAG_ALLOWLIST reason for ${name}`);
	}
	for (const [name, reason] of Object.entries(input.nonFlagConfigKeys)) {
		if (!reason.trim())
			issues.push(`blank NON_FLAG_CONFIG_KEYS reason for ${name}`);
	}
	for (const exemption of input.exemptions) {
		if (!exemption.reason.trim() || !exemption.owner.trim()) {
			issues.push(
				`blank exemption reason/owner for ${exemption.kind}:${exemption.name}`,
			);
		}
	}
	for (const key of duplicateValues(
		input.exemptions.map((entry) => `${entry.kind}:${entry.name}`),
	)) {
		issues.push(`duplicate FLAG_EXEMPTION ${key}`);
	}

	for (const name of input.registeredEnvVars) {
		if (name in input.nonFlagEnv) issues.push(`ledger overlap for env ${name}`);
		if (envExemptions.has(name)) issues.push(`ledger overlap for env ${name}`);
		if (input.retiredEnvVars.has(name))
			issues.push(`ledger overlap for env ${name}`);
	}
	for (const name of Object.keys(input.nonFlagEnv)) {
		if (envExemptions.has(name) || input.retiredEnvVars.has(name)) {
			issues.push(`ledger overlap for env ${name}`);
		}
	}
	for (const name of envExemptions) {
		if (input.retiredEnvVars.has(name))
			issues.push(`ledger overlap for env ${name}`);
		if (!envNames.has(name)) issues.push(`stale env FLAG_EXEMPTION ${name}`);
	}
	for (const path of input.registeredConfigKeys) {
		if (path in input.nonFlagConfigKeys || configExemptions.has(path)) {
			issues.push(`ledger overlap for config key ${path}`);
		}
		if (!configPaths.has(path)) {
			issues.push(`stale registered config key ${path}`);
		}
		if (retiredConfigRoot(path)) {
			issues.push(`ledger overlap for config key ${path}`);
		}
	}
	for (const path of Object.keys(input.nonFlagConfigKeys)) {
		if (configExemptions.has(path) || retiredConfigRoot(path)) {
			issues.push(`ledger overlap for config key ${path}`);
		}
	}
	for (const path of configExemptions) {
		if (retiredConfigRoot(path))
			issues.push(`ledger overlap for config key ${path}`);
		if (!configPaths.has(path))
			issues.push(`stale config FLAG_EXEMPTION ${path}`);
	}
	return [...new Set(issues)];
}

/**
 * FLY-1852: every `ts.createSourceFile` for a scanned source, and every flag
 * scan of one, is tallied here BY FILE so the work-sharing invariants can be
 * asserted deterministically instead of by wall-clock time.
 *
 * Both artifacts are tallied because they are memoized independently, and a
 * test that only counts parses cannot see a lost scan memo (the scan derives
 * the parse, not the other way round).
 *
 * Scope of the per-file tallies (Codex review R4, Low): they count calls to
 * `sourceFile`, `scanCode` and `scanShell` — at most one of each per file —
 * not AST traversals. One `scanCode` call already walks the tree twice
 * (`gatherKeys` then `visit`), and adding a third walk inside it would not
 * move these numbers. That is in scope for this issue, whose regression was
 * repeated whole-file parses and scans, but the invariant should not be read
 * as "no repeated tree walk".
 *
 * The tally is per file, not a total, because a total only supports a
 * threshold and a threshold is not the property. Measured: dropping the scan
 * memo for one file — packages/teamlead/src/bridge/plugin.ts, whose 4 sites
 * cost 1624ms of the original 2962ms — takes it from 1 scan to 4, but the
 * total only moves 39 -> 42 against 47 distinct files, so a "<= one per
 * distinct file" TOTAL still passed (verified: 7/7 green with that regression
 * present). `maxFileParses`/`maxFileScans` state the actual property — no file
 * is parsed or scanned twice — and caught the same regression at 4 > 1.
 */
const parseTally = new Map<string, number>();
const scanTally = new Map<string, number>();
/**
 * How many declared sites produced a verdict. This is the COVERAGE half of
 * the accounting, and it is separate from the per-file tallies on purpose
 * (Codex review R4, Medium): a derived floor over parses+scans could be
 * satisfied while most of the registry went unchecked — evaluating only the
 * first 26 of 56 flags still produced 24 parses + 24 scans against 47 files.
 * Counting verdicts makes "skipped" and "checked" different numbers instead of
 * interchangeable ones.
 *
 * It is incremented at each terminal `return`, via `recordVerdict`, and NOT on
 * entry to the evaluator (Codex review R5, Medium): counting on entry measures
 * dispatch cardinality, not evaluation. An early `return null` inserted after
 * an entry-side increment skipped five real sites — pipeline_work_kind,
 * doc_flow and three ConfigLoader.validate sites — while every number,
 * siteChecks included, matched the baseline exactly. Recording at the returns
 * means a bypass that does not go through `recordVerdict` is not counted.
 * This is a bypass detector, not a proof of semantic correctness; the fixtures
 * carrying same-(file, symbol) config sites are what pin that shape directly.
 */
let siteChecks = 0;

function recordVerdict(verdict: string | null): string | null {
	siteChecks += 1;
	return verdict;
}

function tally(counter: Map<string, number>, file: string): void {
	counter.set(file, (counter.get(file) ?? 0) + 1);
}

function total(counter: Map<string, number>): number {
	let sum = 0;
	for (const count of counter.values()) sum += count;
	return sum;
}

function max(counter: Map<string, number>): number {
	let highest = 0;
	for (const count of counter.values()) {
		if (count > highest) highest = count;
	}
	return highest;
}

export function driftScanParseStats(): {
	sourceFileParses: number;
	sourceScans: number;
	maxFileParses: number;
	maxFileScans: number;
	siteChecks: number;
} {
	return {
		sourceFileParses: total(parseTally),
		sourceScans: total(scanTally),
		maxFileParses: max(parseTally),
		maxFileScans: max(scanTally),
		siteChecks,
	};
}

export function resetDriftScanParseStats(): void {
	parseTally.clear();
	scanTally.clear();
	siteChecks = 0;
}

function sourceFile(source: ScanSource): ts.SourceFile {
	tally(parseTally, source.file);
	return ts.createSourceFile(
		source.file,
		source.text,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(source.file),
	);
}

function normalizedImportTarget(importer: string, target: string): string {
	const base = normalizeFile(join(dirname(importer), target));
	return base.replace(/\.(?:js|mjs)$/, ".ts");
}

function containsIdentifierEvidence(
	file: ts.SourceFile,
	symbol: string,
): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
			node.name?.text === symbol
		) {
			found = true;
			return;
		}
		if (
			(ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name) &&
			node.name.text === symbol
		) {
			found = true;
			return;
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === symbol
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function delegatedEvidence(
	file: ts.SourceFile,
	importer: string,
	modulePath: string,
	exportName: string,
	consumerAnchor: ts.Node,
): boolean {
	const locals = new Set<string>();
	const expected = normalizeFile(modulePath).replace(/\.(?:js|mjs)$/, ".ts");
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			normalizedImportTarget(importer, statement.moduleSpecifier.text) !==
				expected
		) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			if ((element.propertyName?.text ?? element.name.text) === exportName) {
				locals.add(element.name.text);
			}
		}
	}
	let called = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			locals.has(node.expression.text)
		) {
			called = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(consumerAnchor);
	return called;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		return unwrapExpression(node.expression);
	}
	return node;
}

function accessPath(node: ts.Expression): string | null {
	const unwrapped = unwrapExpression(node);
	if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return "this";
	if (ts.isIdentifier(unwrapped)) return unwrapped.text;
	if (ts.isPropertyAccessExpression(unwrapped)) {
		const parent = accessPath(unwrapped.expression);
		return parent ? `${parent}.${unwrapped.name.text}` : null;
	}
	if (
		ts.isElementAccessExpression(unwrapped) &&
		unwrapped.argumentExpression &&
		ts.isStringLiteralLike(unwrapped.argumentExpression)
	) {
		const parent = accessPath(unwrapped.expression);
		return parent ? `${parent}.${unwrapped.argumentExpression.text}` : null;
	}
	return null;
}

function findSymbolNode(file: ts.SourceFile, symbol: string): ts.Node | null {
	const [className, memberName] = symbol.split(".");
	let found: ts.Node | null = null;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			memberName &&
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			accessPath(node.left) === symbol
		) {
			found = node;
			return;
		}
		if (memberName) {
			if (ts.isClassDeclaration(node) && node.name?.text === className) {
				found =
					node.members.find(
						(member) =>
							member.name &&
							ts.isIdentifier(member.name) &&
							member.name.text === memberName,
					) ?? null;
			}
		} else if (
			(ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name) &&
			node.name.text === symbol
		) {
			found = node;
		}
		if (!found) ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function symbolContainsAccess(node: ts.Node, expected: string): boolean {
	let found = false;
	const visit = (child: ts.Node): void => {
		if (found) return;
		if (
			(ts.isPropertyAccessExpression(child) ||
				ts.isElementAccessExpression(child)) &&
			accessPath(child) === expected
		) {
			found = true;
			return;
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateShellDynamic(
	text: string,
	symbol: string,
	envVar: string,
): string | null {
	const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
	const assignment = new RegExp(
		String.raw`(?:^|\s)(?:local\s+)?${escapeRegExp(symbol)}=["']?\$\{${escapeRegExp(envVar)}:-${BOOL_LITERAL}\}`,
		"i",
	);
	if (!lines.some((line) => assignment.test(line))) {
		const functionDeclaration = new RegExp(
			String.raw`^\s*${escapeRegExp(symbol)}\s*\(\)\s*\{`,
		);
		const helperCall = new RegExp(
			String.raw`^\s*${escapeRegExp(symbol)}\s+${escapeRegExp(envVar)}(?:\s|$)`,
		);
		if (
			lines.some((line) => functionDeclaration.test(line)) &&
			lines.some((line) => helperCall.test(line))
		) {
			return null;
		}
		return `dynamic shell site lacks ${symbol} assignment from ${envVar}`;
	}
	const reference = new RegExp(String.raw`\$\{?${escapeRegExp(symbol)}\}?`);
	const gateLine = lines.find(
		(line) =>
			reference.test(line) &&
			(shellBoolComparison(line) || /^\s*case\b/.test(line)),
	);
	if (!gateLine) return `dynamic shell site lacks a gate use of ${symbol}`;
	return null;
}

export interface ReadSiteEvidenceRequest {
	site: ReadSiteLike;
	envVar?: string;
	configKey?: string;
}

/**
 * FLY-1852: evaluate every declared readSite of ONE production file, sharing
 * the two expensive per-file artifacts — the `ts.SourceFile` and the flag scan
 * — across all of that file's sites.
 *
 * The previous shape (`validateReadSiteEvidence` per site) re-derived both from
 * scratch on every call, and derived them TWICE per call, because the nested
 * `scanSources([source])` parsed the file a second time. Big multi-site files
 * paid the bill over and over: packages/teamlead/src/bridge/plugin.ts is 372KB
 * with 4 declared sites and alone cost ~1.6s of a 5s test budget.
 *
 * Both artifacts stay lazy, so a `.sh` file whose sites resolve entirely
 * through the shell scanner never gets TypeScript-parsed at all. Nothing about
 * WHAT counts as evidence changes here — this is work sharing only.
 *
 * What backs that claim, stated precisely (Codex review, Low). The in-repo
 * tests pin AGGREGATION consistency, not old-vs-new equivalence: the
 * single-site `validateReadSiteEvidence()` now delegates here, so using it as
 * an oracle is circular. The old-vs-new evidence is external — a review-time
 * harness ran both implementations over all declared readSites crossed with
 * injected site mutations and compared every verdict — plus direct reading of
 * the two code paths, which are the same branches in the same order.
 *
 * That equivalence holds for inputs the TypeScript parser can complete. The
 * old code parsed eagerly before the pattern switch, so an input pathological
 * enough to make the parser itself throw (e.g. thousands of nested
 * parentheses) used to surface a RangeError even for a site whose pattern
 * never consults the AST; such a site now returns its normal verdict instead.
 * No real readSite is affected and no evidence rule is loosened. Note this
 * helper never reported parser `diagnostics` in either version — that is the
 * separate full-source `scanSources()` guard's job, and it is unchanged.
 */
export function validateReadSitesForFile(input: {
	file: string;
	text: string;
	requests: readonly ReadSiteEvidenceRequest[];
	parsedFile?: ts.SourceFile;
}): (string | null)[] {
	const source = { file: input.file, text: input.text };
	const isShell = input.file.endsWith(".sh");
	let parsedFile: ts.SourceFile | undefined = input.parsedFile;
	const parseOnce = (): ts.SourceFile => {
		parsedFile ??= sourceFile(source);
		return parsedFile;
	};
	let scanned: ScanResult | undefined;
	const scanOnce = (): ScanResult => {
		scanned ??= isShell ? scanShell(source) : scanCode(source, parseOnce());
		return scanned;
	};

	return input.requests.map(({ site, envVar }) => {
		if (site.pattern === "dynamic" && isShell) {
			return recordVerdict(
				envVar
					? validateShellDynamic(input.text, site.symbol, envVar)
					: "dynamic shell site requires envVar",
			);
		}
		if (site.pattern === "delegated") {
			if (!site.resolverModule || !site.resolverSymbol) {
				return recordVerdict(
					"delegated site requires resolverModule and resolverSymbol",
				);
			}
			const anchor = findSymbolNode(parseOnce(), site.symbol);
			if (!anchor) {
				return recordVerdict(
					`delegated consumer anchor ${site.symbol} not found`,
				);
			}
			return recordVerdict(
				delegatedEvidence(
					parseOnce(),
					input.file,
					site.resolverModule,
					site.resolverSymbol,
					anchor,
				)
					? null
					: "delegated site lacks canonical import and call",
			);
		}
		if (site.pattern === "config") {
			if (!site.configAccess) {
				return recordVerdict("config site requires configAccess");
			}
			const symbol = findSymbolNode(parseOnce(), site.symbol);
			if (!symbol) {
				return recordVerdict(`config symbol ${site.symbol} not found`);
			}
			return recordVerdict(
				symbolContainsAccess(symbol, site.configAccess)
					? null
					: `config access ${site.configAccess} not found in ${site.symbol}`,
			);
		}
		if (!envVar || !scanOnce().rawCodeHits.some((hit) => hit.name === envVar)) {
			return recordVerdict(
				`${envVar ?? "envVar"} not found as code in ${input.file}`,
			);
		}
		if (site.pattern === "dynamic") {
			if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(site.symbol)) {
				return recordVerdict(
					`dynamic symbol must be a real identifier: ${site.symbol}`,
				);
			}
			if (!containsIdentifierEvidence(parseOnce(), site.symbol)) {
				return recordVerdict(`dynamic identifier ${site.symbol} not found`);
			}
		}
		return recordVerdict(null);
	});
}

export interface DeclaredFlagLike {
	name: string;
	envVar?: string;
	configKey?: string;
	readSites: readonly ReadSiteLike[];
}

const FLAG_STORE_RUNTIME_MODULE =
	"packages/teamlead/src/bridge/flag-store-runtime.ts";

function storeResolverReadsExactFlag(
	file: ts.SourceFile,
	resolverSymbol: string,
	flagName: string,
): boolean {
	const resolver = findSymbolNode(file, resolverSymbol);
	if (!resolver) return false;
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === "readBoolean" ||
				node.expression.text === "readFlagValue") &&
			node.arguments.length >= 2 &&
			ts.isStringLiteralLike(node.arguments[1] as ts.Expression) &&
			(node.arguments[1] as ts.StringLiteralLike).text === flagName
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(resolver);
	return found;
}

/**
 * FLY-1852: the whole registry-wide readSite evidence pass, in one place.
 *
 * This lives here rather than inline in feature-flags-drift.test.ts on
 * purpose. The guard's expensive part is the per-file work sharing, and the
 * regression that reintroduces the timeout is "go back to evaluating one site
 * at a time". If the guard owned the grouping inline, a revert of the GUARD
 * would slip past parse-count tests that only exercise the batch helper —
 * verified, that revert really did stay green. Keeping the grouping here makes
 * the guard a thin call, so the counted path and the shipped path are the same
 * code.
 *
 * Messages come back in declaration order (flag order, then readSite order),
 * identical to evaluating the sites one by one, so failure output is stable
 * regardless of how the work is grouped underneath.
 */
export function validateDeclaredReadSites(input: {
	flags: readonly DeclaredFlagLike[];
	sourceByFile: ReadonlyMap<string, string>;
}): string[] {
	interface Entry {
		slot: number;
		flag: string;
		site: ReadSiteLike;
		envVar?: string;
		configKey?: string;
	}
	const slots: (string | null)[] = [];
	const byFile = new Map<string, Entry[]>();
	const parsedStoreResolvers = new Map<string, ts.SourceFile>();
	for (const flag of input.flags) {
		for (const site of flag.readSites) {
			const slot = slots.length;
			slots.push(null);
			if (!input.sourceByFile.has(site.file)) {
				slots[slot] = recordVerdict(
					`${flag.name} @ ${site.file}: production file not scanned`,
				);
				continue;
			}
			const entry: Entry = {
				slot,
				flag: flag.name,
				site,
				envVar: flag.envVar,
				configKey: flag.configKey,
			};
			const bucket = byFile.get(site.file);
			if (bucket) bucket.push(entry);
			else byFile.set(site.file, [entry]);
		}
	}
	for (const bucket of byFile.values()) {
		for (const entry of bucket) {
			if (entry.site.resolverModule !== FLAG_STORE_RUNTIME_MODULE) continue;
			const text = input.sourceByFile.get(FLAG_STORE_RUNTIME_MODULE);
			if (!text || parsedStoreResolvers.has(FLAG_STORE_RUNTIME_MODULE))
				continue;
			parsedStoreResolvers.set(
				FLAG_STORE_RUNTIME_MODULE,
				sourceFile({ file: FLAG_STORE_RUNTIME_MODULE, text }),
			);
		}
	}
	for (const [file, bucket] of byFile) {
		const issues = validateReadSitesForFile({
			file,
			text: input.sourceByFile.get(file) as string,
			requests: bucket,
			parsedFile: parsedStoreResolvers.get(file),
		});
		issues.forEach((issue, index) => {
			const entry = bucket[index] as Entry;
			if (issue) slots[entry.slot] = `${entry.flag} @ ${file}: ${issue}`;
			if (
				!issue &&
				entry.site.resolverModule === FLAG_STORE_RUNTIME_MODULE &&
				entry.site.resolverSymbol
			) {
				const resolverFile = parsedStoreResolvers.get(
					FLAG_STORE_RUNTIME_MODULE,
				);
				if (
					!resolverFile ||
					!storeResolverReadsExactFlag(
						resolverFile,
						entry.site.resolverSymbol,
						entry.flag,
					)
				) {
					slots[entry.slot] =
						`${entry.flag} @ ${file}: resolver ${entry.site.resolverSymbol} does not read exact managed flag ${entry.flag}`;
				}
			}
		});
	}
	return slots.filter((entry): entry is string => entry !== null);
}

export function validateReadSiteEvidence(input: {
	file: string;
	text: string;
	site: ReadSiteLike;
	envVar?: string;
	configKey?: string;
}): string | null {
	return validateReadSitesForFile({
		file: input.file,
		text: input.text,
		requests: [
			{ site: input.site, envVar: input.envVar, configKey: input.configKey },
		],
	})[0] as string | null;
}
