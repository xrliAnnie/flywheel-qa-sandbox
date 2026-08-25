#!/usr/bin/env -S pnpm exec tsx

import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ConfigLoader } from "../../../../packages/config/src/ConfigLoader.ts";
import {
	compileWorkflowMenuSeed,
	loadProjectMenuConfig,
	resolveLeadMenus,
} from "../../../../packages/teamlead/src/workflow-menu.ts";
import { buildWorkflowRunSnapshotV2 } from "../../../../packages/teamlead/src/workflow-run-snapshot.ts";

const REQUIRED_FILES = [
	"README.md",
	"CLAUDE.md",
	".gitignore",
	"MEMORY.md",
	"memory/README.md",
	".claude/skills/README.md",
	".claude/skills/meal-menu/SKILL.md",
	"archive/README.md",
	"archive/weekly/README.md",
	".flywheel/config.yaml",
	".flywheel/agents/life/life-executor.md",
	".flywheel/menus/ic-roster.yaml",
	".flywheel/menus/adoption.yaml",
	".lead/belle-lead/identity-dispatch-addendum.proposed.md",
	"doc/life/README.md",
] as const;

const EXPECTED_CONFLICTS = [".gitignore", "CLAUDE.md", "README.md"];

type EntryKind = "directory" | "file" | "symlink" | "other";

function fail(message: string): never {
	throw new Error(`FLY-2034 workspace verification failed: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) fail(message);
}

function filesUnder(root: string): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const absolute = join(directory, entry.name);
			const path = relative(root, absolute);
			if (entry.isDirectory()) visit(absolute);
			else found.push(path);
		}
	};
	visit(root);
	return found.sort();
}

function entriesUnder(root: string): Map<string, EntryKind> {
	const found = new Map<string, EntryKind>();
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const absolute = join(directory, entry.name);
			const path = relative(root, absolute);
			const kind: EntryKind = entry.isDirectory()
				? "directory"
				: entry.isFile()
					? "file"
					: entry.isSymbolicLink()
						? "symlink"
						: "other";
			found.set(path, kind);
			if (kind === "directory") visit(absolute);
		}
	};
	visit(root);
	return found;
}

function verifyRequiredStructure(root: string): void {
	for (const path of REQUIRED_FILES) {
		assert(existsSync(join(root, path)), `missing required file: ${path}`);
	}
	const skills = join(root, "skills");
	assert(existsSync(skills), "missing top-level skills browse path");
	assert(lstatSync(skills).isSymbolicLink(), "top-level skills must be a symlink");
	const target = readlinkSync(skills);
	assert(!target.startsWith(sep), "top-level skills symlink must be relative");
	assert(target === ".claude/skills", `unexpected skills symlink target: ${target}`);
	assert(
		existsSync(join(skills, "meal-menu", "SKILL.md")),
		"meal-menu skill is not readable through top-level skills symlink",
	);
}

function verifyConflictSurface(scaffoldRoot: string, liveRoot: string): void {
	const scaffoldEntries = entriesUnder(scaffoldRoot);
	const conflicts = [...entriesUnder(liveRoot)]
		.filter(([path, liveKind]) => {
			const scaffoldKind = scaffoldEntries.get(path);
			return (
				scaffoldKind !== undefined &&
				!(liveKind === "directory" && scaffoldKind === "directory")
			);
		})
		.map(([path]) => path)
		.sort();
	assert(
		JSON.stringify(conflicts) === JSON.stringify(EXPECTED_CONFLICTS),
		`root-relative conflict surface changed: ${JSON.stringify(conflicts)}`,
	);
	for (const path of EXPECTED_CONFLICTS) {
		const live = readFileSync(join(liveRoot, path), "utf8").trimEnd();
		const scaffold = readFileSync(join(scaffoldRoot, path), "utf8");
		assert(
			scaffold.startsWith(live),
			`${path} does not preserve the complete live baseline as a prefix`,
		);
	}
}

function verifyConflictTypeNegativeControl(scaffoldRoot: string): void {
	const liveFixture = mkdtempSync(join(tmpdir(), "fly2034-belle-conflict-fixture-"));
	try {
		for (const path of EXPECTED_CONFLICTS) {
			writeFileSync(join(liveFixture, path), "");
		}
		mkdirSync(join(liveFixture, "skills"));
		expectThrows(
			() => verifyConflictSurface(scaffoldRoot, liveFixture),
			/skills/,
			"live directory versus scaffold symlink negative control",
		);
	} finally {
		rmSync(liveFixture, { recursive: true, force: true });
	}
}

function verifyNoSecretOrMachinePath(root: string): void {
	const forbidden: Array<[string, RegExp]> = [
		["machine-specific user path", /\/Users\/[A-Za-z0-9._-]+\//],
		["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
		["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
		["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/],
		["Discord bot token", /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/],
	];
	for (const path of filesUnder(root)) {
		const absolute = join(root, path);
		if (lstatSync(absolute).isSymbolicLink()) continue;
		const content = readFileSync(absolute, "utf8");
		for (const [label, pattern] of forbidden) {
			assert(!pattern.test(content), `${path} contains ${label}`);
		}
	}
}

async function verifyConfig(root: string): Promise<void> {
	const configPath = join(root, ".flywheel", "config.yaml");
	const loader = new ConfigLoader(async (path) => readFileSync(path, "utf8"));
	const config = await loader.load(configPath);
	assert(config.project === "personal-assistant", "config project must preserve personal-assistant");
	assert(config.linear.team_id === "LEARN", "config must reuse Linear team LEARN");
	assert(config.default_agent === "life", "config default_agent must be life");
	assert(config.doc_flow?.default_department === "life", "doc flow must resolve to life");
	assert(
		isDeepStrictEqual(config.agents?.life?.match.labels, ["personal-assistant"]),
		"life agent must match the Founder-approved personal-assistant label",
	);
}

function expectThrows(action: () => unknown, expected: RegExp, label: string): void {
	try {
		action();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label} threw unexpected error: ${message}`);
		return;
	}
	fail(`${label} unexpectedly passed`);
}

function withTemporaryCopy(root: string, action: (copy: string) => void): void {
	const copy = mkdtempSync(join(tmpdir(), "fly2034-belle-workspace-"));
	try {
		cpSync(root, copy, { recursive: true });
		action(copy);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
}

function verifyMenuMaterialization(root: string): {
	snapshotDigest: string;
	agentDigest: string;
} {
	const menuConfig = loadProjectMenuConfig(root);
	assert(
		menuConfig.roster.generic === ".flywheel/agents/life/life-executor.md",
		"generic role must map to life-executor",
	);
	assert(
		JSON.stringify(menuConfig.adoption["belle-lead"]) === JSON.stringify(["generic"]),
		"belle-lead must adopt only the generic menu",
	);
	const menu = resolveLeadMenus({ projectRoot: root, leadId: "belle-lead" })[0];
	assert(menu?.shape === "generic", "belle-lead must resolve the generic menu");
	const seed = compileWorkflowMenuSeed(menu);
	assert(seed.templateId === "tpl_generic_menu", "generic menu compiled to wrong template");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: seed.templateId, revision: 1 },
		manifest: seed.manifest,
		canonicalRoot: root,
		workKind: { taskCategory: "generic", categorySource: "label" },
	});
	const nodeTypes = snapshot.resolved.nodes.map((node) => node.type);
	assert(
		JSON.stringify(nodeTypes) === JSON.stringify(["generic", "gate", "land"]),
		`generic snapshot shape changed: ${JSON.stringify(nodeTypes)}`,
	);
	const execute = snapshot.resolved.nodes[0];
	const agent = readFileSync(
		join(root, ".flywheel", "agents", "life", "life-executor.md"),
		"utf8",
	).slice(0, 40_000);
	assert(execute?.agent?.content === agent, "snapshot did not embed life-executor bytes");
	assert(Boolean(execute.agent.digest), "snapshot life-executor digest is empty");

	withTemporaryCopy(root, (copy) => {
		rmSync(join(copy, ".flywheel", "menus", "ic-roster.yaml"));
		expectThrows(
			() => resolveLeadMenus({ projectRoot: copy, leadId: "belle-lead" }),
			/(?:ENOENT|ic-roster)/i,
			"missing IC roster negative control",
		);
	});
	withTemporaryCopy(root, (copy) => {
		rmSync(join(copy, ".flywheel", "agents", "life", "life-executor.md"));
		expectThrows(
			() => loadProjectMenuConfig(copy),
			/ic-roster\.generic file does not exist/i,
			"missing executor negative control",
		);
	});

	return {
		snapshotDigest: snapshot.snapshot_digest,
		agentDigest: execute.agent.digest,
	};
}

function verifyContentContracts(root: string): void {
	const skill = readFileSync(
		join(root, ".claude", "skills", "meal-menu", "SKILL.md"),
		"utf8",
	);
	assert(skill.startsWith("---\nname: meal-menu\n"), "meal-menu skill frontmatter is missing");
	assert(skill.includes("tasks/meal-prep/PREFERENCES.md"), "meal-menu skill lost its preference source");
	assert(skill.includes("archive/meal-menu/"), "meal-menu skill does not archive each output");
	assert(skill.includes("archive/weekly/"), "meal-menu skill does not update the weekly ledger");
	assert(/never (?:spend money|place an order)/i.test(skill), "meal-menu skill lost the no-purchase boundary");

	const archive = readFileSync(join(root, "archive", "README.md"), "utf8");
	const weekly = readFileSync(join(root, "archive", "weekly", "README.md"), "utf8");
	assert(archive.includes("<YYYY-MM-DD>-<slug>.md"), "archive naming contract is missing");
	assert(weekly.includes("<YYYY-Www>.md"), "weekly ledger naming contract is missing");
	assert(weekly.includes("rg"), "weekly ledger is not documented as queryable");

	const executor = readFileSync(
		join(root, ".flywheel", "agents", "life", "life-executor.md"),
		"utf8",
	);
	assert(executor.includes("name: life-executor"), "life-executor frontmatter is missing");
	assert(executor.includes("archive/"), "life-executor does not require durable archiving");
	assert(/never spend money/i.test(executor), "life-executor lost the no-purchase boundary");
}

async function main(): Promise<void> {
	const arguments_ = process.argv.slice(2);
	const runtimeOnly = arguments_[0] === "--runtime-only";
	const scaffoldArgument = runtimeOnly ? arguments_[1] : arguments_[0];
	const liveArgument = runtimeOnly ? undefined : arguments_[1];
	if (!scaffoldArgument || (!runtimeOnly && !liveArgument)) {
		fail(
			`usage: ${basename(process.argv[1] ?? "verify-belle-workspace.ts")} <scaffold-root> <live-personal-assistant-root> | --runtime-only <connected-live-root>`,
		);
	}
	const scaffoldRoot = realpathSync(resolve(scaffoldArgument));
	const liveRoot = liveArgument ? realpathSync(resolve(liveArgument)) : undefined;
	verifyRequiredStructure(scaffoldRoot);
	if (!runtimeOnly) {
		assert(liveRoot, "live root is required for scaffold verification");
		verifyConflictSurface(scaffoldRoot, liveRoot);
		verifyConflictTypeNegativeControl(scaffoldRoot);
		verifyNoSecretOrMachinePath(scaffoldRoot);
	}
	verifyContentContracts(scaffoldRoot);
	await verifyConfig(scaffoldRoot);
	const evidence = verifyMenuMaterialization(scaffoldRoot);
	const scaffoldDigest = createHash("sha256")
		.update(
			filesUnder(scaffoldRoot)
				.map((path) => {
					const absolute = join(scaffoldRoot, path);
					const content = lstatSync(absolute).isSymbolicLink()
						? `link:${readlinkSync(absolute)}`
						: readFileSync(absolute);
					return `${path}\0${content}`;
				})
				.join("\0"),
		)
		.digest("hex");
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			mode: runtimeOnly ? "runtime-only" : "scaffold",
			scaffoldRoot,
			...(!runtimeOnly ? { liveRoot, conflicts: EXPECTED_CONFLICTS } : {}),
			scaffoldDigest,
			...evidence,
		})}\n`,
	);
}

await main();
