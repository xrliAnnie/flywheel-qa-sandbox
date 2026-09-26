import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	materializeRunnerPrefixArtifacts,
	type RunnerPrefixArtifactInput,
	verifyRunnerPrefixArtifacts,
} from "../src/runner-prefix-artifacts.js";

const interleaving = vi.hoisted(() => ({
	afterLstat: undefined as ((path: unknown) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
			const result = actual.lstatSync(...args);
			interleaving.afterLstat?.(args[0]);
			return result;
		},
	};
});

const roots: string[] = [];
const hash = (text: string | Buffer) =>
	createHash("sha256").update(text).digest("hex");

function fixture(): RunnerPrefixArtifactInput {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-prefix-")));
	roots.push(root);
	const sourceRoot = join(root, "cache");
	mkdirSync(sourceRoot, { mode: 0o700 });
	writeFileSync(join(sourceRoot, "SKILL.md"), "Read scripts/run.sh\n");
	writeFileSync(join(sourceRoot, "run.sh"), "#!/bin/sh\nprintf ready\n");
	chmodSync(join(sourceRoot, "SKILL.md"), 0o777);
	chmodSync(join(sourceRoot, "run.sh"), 0o777);
	return {
		trustedRoots: [sourceRoot],
		targetDirectory: join(root, "execution-private"),
		identity: {
			version: 1,
			executionId: "execution-1",
			activationId: "activation-1",
			sessionId: "session-1",
			role: "implement",
			profileDigest: hash("profile"),
		},
		sources: [
			{
				sourcePath: join(sourceRoot, "SKILL.md"),
				sha256: hash("Read scripts/run.sh\n"),
				destination: "plugin/SKILL.md",
			},
			{
				sourcePath: join(sourceRoot, "run.sh"),
				sha256: hash("#!/bin/sh\nprintf ready\n"),
				destination: "plugin/scripts/run.sh",
				executable: true,
			},
		],
	};
}

afterEach(() => {
	interleaving.afterLstat = undefined;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("runner prefix artifacts", () => {
	it("pins both original and generated plugin manifest bytes without logging content", () => {
		const input = fixture();
		const sourcePath = join(input.trustedRoots[0]!, "plugin.json");
		const original =
			'{"name":"bundle","agents":["./agents/a.md","./agents/b.md"]}';
		const pluginManifest = '{"name":"bundle","agents":["./agents/a.md"]}';
		writeFileSync(sourcePath, original);
		input.sources = [
			{
				sourcePath,
				sha256: hash(original),
				destination: "plugin/.claude-plugin/plugin.json",
				pluginManifest,
			},
		];
		const result = materializeRunnerPrefixArtifacts(input);
		expect(
			readFileSync(
				join(result.directory, "plugin/.claude-plugin/plugin.json"),
				"utf8",
			),
		).toBe(pluginManifest);
		expect(verifyRunnerPrefixArtifacts(input)).toEqual(result);
		const stamp = readFileSync(result.stampPath, "utf8");
		expect(stamp).toContain(hash(original));
		expect(stamp).toContain(hash(pluginManifest));
		expect(stamp).not.toContain("agents/a.md");
		input.sources[0]!.pluginManifest = '{"name":"bundle","agents":[]}';
		expect(() => verifyRunnerPrefixArtifacts(input)).toThrow(/hash mismatch/);
	});

	it.each(["not-json", '{"name":"changed"}', '{"name":"bundle","hooks":{}}'])(
		"rejects a generated manifest changing non-component metadata: %s",
		(pluginManifest) => {
			const input = fixture();
			const sourcePath = join(input.trustedRoots[0]!, "plugin.json");
			const original = '{"name":"bundle"}';
			writeFileSync(sourcePath, original);
			input.sources = [
				{
					sourcePath,
					sha256: hash(original),
					destination: "plugin/.claude-plugin/plugin.json",
					pluginManifest,
				},
			];
			expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(
				/manifest transformation/,
			);
		},
	);

	it("does not permit generated content to replace skill or hook text", () => {
		const input = fixture();
		input.sources[0]!.pluginManifest = '{"name":"bundle"}';
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(
			/manifest destination/,
		);
	});

	it.each(["mode", "link"])(
		"rejects artifact %s changes between pre-open lstat and open",
		(mutation) => {
			const input = fixture();
			const result = materializeRunnerPrefixArtifacts(input);
			const target = join(result.directory, "plugin/SKILL.md");
			let changed = false;
			interleaving.afterLstat = (path) => {
				if (path !== target || changed) return;
				changed = true;
				if (mutation === "mode") chmodSync(target, 0o644);
				else linkSync(target, join(roots[roots.length - 1]!, "extra-link"));
			};
			expect(() => verifyRunnerPrefixArtifacts(input)).toThrow(/mode or link/);
			expect(changed).toBe(true);
		},
	);

	it.each([0o400, 0o777])(
		"creates an immediately verifiable bundle under restrictive umask %s",
		(mask) => {
			const input = fixture();
			const original = process.umask(mask);
			try {
				const result = materializeRunnerPrefixArtifacts(input);
				expect(verifyRunnerPrefixArtifacts(input)).toEqual(result);
				expect(process.umask()).toBe(mask);
			} finally {
				process.umask(original);
				// Keep failed regressions removable even when the old implementation
				// leaves directories without their owner-read or owner-execute bits.
				for (const path of [
					input.targetDirectory,
					join(input.targetDirectory, "artifacts"),
					join(input.targetDirectory, "artifacts/plugin"),
					join(input.targetDirectory, "artifacts/plugin/scripts"),
				]) {
					if (existsSync(path)) chmodSync(path, 0o700);
				}
			}
		},
	);

	it("copies the complete listed asset closure with private modes and explicit execute permission", () => {
		const input = fixture();
		const result = materializeRunnerPrefixArtifacts(input);
		expect(result.directory).toBe(join(input.targetDirectory, "artifacts"));
		expect(result.stampPath).toBe(join(result.directory, "stamp.json"));
		for (const source of input.sources) {
			const target = join(result.directory, source.destination);
			expect(readFileSync(target)).toEqual(readFileSync(source.sourcePath));
			expect(lstatSync(target).isSymbolicLink()).toBe(false);
			expect(statSync(target).mode & 0o777).toBe(
				source.executable ? 0o700 : 0o600,
			);
		}
		for (const path of [
			input.targetDirectory,
			result.directory,
			join(result.directory, "plugin"),
			join(result.directory, "plugin/scripts"),
		]) {
			expect(statSync(path).mode & 0o777).toBe(0o700);
		}
		expect(statSync(result.stampPath).mode & 0o777).toBe(0o600);
		writeFileSync(input.sources[0]!.sourcePath, "mutated cache");
		expect(
			readFileSync(join(result.directory, "plugin/SKILL.md"), "utf8"),
		).toBe("Read scripts/run.sh\n");
	});

	it("canonicalizes input order and omits source contents and unrecognized metadata from the stamp", () => {
		const input = fixture();
		Object.assign(input.identity, { secret: "do-not-persist" });
		Object.assign(input.sources[0]!, { content: "do-not-persist" });
		const first = materializeRunnerPrefixArtifacts(input);
		const second = materializeRunnerPrefixArtifacts({
			...input,
			targetDirectory: `${input.targetDirectory}-second`,
			sources: [...input.sources].reverse(),
			trustedRoots: [...input.trustedRoots].reverse(),
		});
		expect(first.manifestDigest).toBe(second.manifestDigest);
		expect(readFileSync(first.stampPath)).toEqual(
			readFileSync(second.stampPath),
		);
		expect(readFileSync(first.stampPath, "utf8")).not.toContain(
			"do-not-persist",
		);
		expect(readFileSync(first.stampPath, "utf8")).not.toContain("printf ready");
		expect(first.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it.each([
		"../escape",
		"plugin/../escape",
		"/absolute",
		"C:\\absolute",
		"plugin\\escape",
		"plugin/*",
		"plugin/?",
		"plugin/[a]",
		"plugin/{a,b}",
		"plugin/\0file",
		"./file",
		"plugin//file",
		"stamp.json",
		"stamp.json/nested",
	])(
		"rejects unsafe or reserved destination %j without publishing",
		(destination) => {
			const input = fixture();
			input.sources[0]!.destination = destination;
			expect(() => materializeRunnerPrefixArtifacts(input)).toThrow();
			expect(existsSync(input.targetDirectory)).toBe(false);
		},
	);

	it("rejects sources outside trusted roots, including a sibling with the same root prefix", () => {
		const input = fixture();
		const outside = `${input.trustedRoots[0]}-outside`;
		mkdirSync(outside);
		input.sources[0]!.sourcePath = join(outside, "SKILL.md");
		writeFileSync(input.sources[0]!.sourcePath, "Read scripts/run.sh\n");
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/source/);
		expect(existsSync(input.targetDirectory)).toBe(false);
	});

	it.each([false, true])(
		"rejects source symlinks including directory traversal through symlinks (directory=%s)",
		(directory) => {
			const input = fixture();
			const outside = join(roots[roots.length - 1]!, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "file"), "Read scripts/run.sh\n");
			const link = join(input.trustedRoots[0]!, "link");
			symlinkSync(directory ? outside : join(outside, "file"), link);
			input.sources[0]!.sourcePath = directory ? join(link, "file") : link;
			expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/source/);
			expect(existsSync(input.targetDirectory)).toBe(false);
		},
	);

	it("rejects directory sources and stale hashes before any published target appears", () => {
		const input = fixture();
		input.sources[1]!.sha256 = hash("different bytes");
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/hash/);
		expect(existsSync(input.targetDirectory)).toBe(false);
		input.sources[1]!.sourcePath = input.trustedRoots[0]!;
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/source/);
	});

	it.each(["same", "parent"])(
		"rejects overlapping destinations (%s) and leaves no partial bundle",
		(overlap) => {
			const input = fixture();
			input.sources[1]!.destination =
				overlap === "same"
					? input.sources[0]!.destination
					: "plugin/SKILL.md/child";
			expect(() => materializeRunnerPrefixArtifacts(input)).toThrow();
			expect(existsSync(input.targetDirectory)).toBe(false);
		},
	);

	it("cleans an exclusively created reservation after a write failure", () => {
		const input = fixture();
		input.sources[1]!.destination = `plugin/${"x".repeat(300)}`;
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow();
		expect(existsSync(input.targetDirectory)).toBe(false);
		expect(readdirSync(roots[roots.length - 1]!)).toEqual(["cache"]);
	});

	it("never replaces an active or incomplete reservation", () => {
		const input = fixture();
		mkdirSync(input.targetDirectory, { mode: 0o700 });
		const original = lstatSync(input.targetDirectory).ino;
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/exist/);
		expect(lstatSync(input.targetDirectory).ino).toBe(original);
		expect(() => verifyRunnerPrefixArtifacts(input)).toThrow();
		rmSync(input.targetDirectory, { recursive: true });
		const result = materializeRunnerPrefixArtifacts(input);
		const stamp = readFileSync(result.stampPath);
		expect(() => materializeRunnerPrefixArtifacts(input)).toThrow(/exist/);
		expect(readFileSync(result.stampPath)).toEqual(stamp);
	});

	it("verifies an exact resume without changing the bundle", () => {
		const input = fixture();
		const first = materializeRunnerPrefixArtifacts(input);
		const before = statSync(first.stampPath);
		expect(
			verifyRunnerPrefixArtifacts({
				...input,
				sources: [...input.sources].reverse(),
			}),
		).toEqual(first);
		expect(statSync(first.stampPath).mtimeMs).toBe(before.mtimeMs);
	});

	it.each([
		"version",
		"executionId",
		"activationId",
		"reviewRequestId",
		"sessionId",
		"role",
		"profileDigest",
	])("rejects resume identity drift in %s", (key) => {
		const input = fixture();
		materializeRunnerPrefixArtifacts(input);
		const changed = {
			...input.identity,
			[key]:
				key === "version"
					? 2
					: key === "role"
						? "qa"
						: key === "profileDigest"
							? hash("changed")
							: "changed",
		};
		expect(() =>
			verifyRunnerPrefixArtifacts({ ...input, identity: changed }),
		).toThrow();
	});

	it("rejects source drift during resume even when immutable copies still match", () => {
		const input = fixture();
		materializeRunnerPrefixArtifacts(input);
		writeFileSync(input.sources[0]!.sourcePath, "different bytes");
		expect(() => verifyRunnerPrefixArtifacts(input)).toThrow(/hash/);
	});

	it.each([
		"bytes",
		"stamp",
		"extra",
		"file-mode",
		"directory-mode",
		"symlink",
	])("rejects artifact or metadata tampering: %s", (tamper) => {
		const input = fixture();
		const result = materializeRunnerPrefixArtifacts(input);
		const target = join(result.directory, "plugin/SKILL.md");
		if (tamper === "bytes") writeFileSync(target, "changed");
		if (tamper === "stamp") writeFileSync(result.stampPath, "{}");
		if (tamper === "extra")
			writeFileSync(join(result.directory, "unlisted"), "extra");
		if (tamper === "file-mode") chmodSync(target, 0o644);
		if (tamper === "directory-mode")
			chmodSync(join(result.directory, "plugin"), 0o755);
		if (tamper === "symlink") {
			rmSync(target);
			symlinkSync(input.sources[0]!.sourcePath, target);
		}
		expect(() => verifyRunnerPrefixArtifacts(input)).toThrow();
	});

	it.each(["target", "parent", "artifacts", "stamp"])(
		"rejects symlink substitution at %s",
		(location) => {
			const input = fixture();
			const result = materializeRunnerPrefixArtifacts(input);
			const outside = join(roots[roots.length - 1]!, "outside");
			mkdirSync(outside);
			if (location === "parent") {
				const link = join(roots[roots.length - 1]!, "alias");
				symlinkSync(roots[roots.length - 1]!, link);
				input.targetDirectory = join(link, "execution-private");
			} else {
				const path =
					location === "target"
						? input.targetDirectory
						: location === "artifacts"
							? result.directory
							: result.stampPath;
				rmSync(path, { recursive: true });
				symlinkSync(outside, path);
			}
			expect(() => verifyRunnerPrefixArtifacts(input)).toThrow();
			expect(() => materializeRunnerPrefixArtifacts(input)).toThrow();
			expect(readdirSync(outside)).toEqual([]);
		},
	);
});
