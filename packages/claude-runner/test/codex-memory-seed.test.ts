import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publishCodexMemorySeed } from "../src/codex-memory-seed.js";

const roots: string[] = [];

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "flywheel-memory-seed-"));
	roots.push(root);
	return root;
}

function writeMemory(
	homesRoot: string,
	executionId: string,
	relativePath: string,
	content: string,
): void {
	const path = join(homesRoot, executionId, "memories", relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function readTree(root: string, relative = ""): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of readdirSync(join(root, relative)).sort()) {
		const path = join(root, relative, name);
		const child = relative ? `${relative}/${name}` : name;
		if (statSync(path).isDirectory())
			Object.assign(files, readTree(root, child));
		else files[child] = readFileSync(path).toString("base64");
	}
	return files;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("publishCodexMemorySeed", () => {
	it("stores one byte-identical snapshot while retaining every source", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "# learned\n");
		writeMemory(homesRoot, "exec-b", "MEMORY.md", "# learned\n");

		const result = publishCodexMemorySeed({
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [
				{
					executionId: "exec-b",
					issueId: "issue-b",
					issueIdentifier: "FLY-2",
					issueTitle: "Second",
					startedAt: "2026-09-02 03:04:05",
				},
				{
					executionId: "exec-a",
					issueId: "issue-a",
					issueIdentifier: "FLY-1",
					issueTitle: "First",
					startedAt: "2026-09-01 03:04:05.123",
				},
			],
			skipped: [],
		});

		expect(result.reused).toBe(false);
		expect(result.manifest.sources.map((source) => source.executionId)).toEqual(
			["exec-a", "exec-b"],
		);
		expect(result.manifest.sources.map((source) => source.startedAt)).toEqual([
			"2026-09-01T03:04:05.123Z",
			"2026-09-02T03:04:05.000Z",
		]);
		expect(result.manifest.snapshots).toHaveLength(1);
		const snapshot = result.manifest.snapshots[0];
		expect(
			result.manifest.sources.map((source) => source.snapshotHash),
		).toEqual([snapshot.hash, snapshot.hash]);
		expect(
			readFileSync(
				join(result.directory, "snapshots", snapshot.hash, "MEMORY.md"),
				"utf8",
			),
		).toBe("# learned\n");
	});

	it("copies only the historical Markdown whitelist and preserves conflicting trees deterministically", () => {
		const run = (reverse: boolean) => {
			const root = fixtureRoot();
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			writeMemory(
				homesRoot,
				"exec-a",
				"MEMORY.md",
				"See rollout_summaries/a.md\n",
			);
			writeMemory(homesRoot, "exec-a", "memory_summary.md", "Summary A\n");
			writeMemory(homesRoot, "exec-a", "raw_memories.md", "Raw A\n");
			writeMemory(homesRoot, "exec-a", "rollout_summaries/a.md", "Rollout A\n");
			writeMemory(
				homesRoot,
				"exec-a",
				"skills/nested/SKILL.md",
				"Skill note\n",
			);
			writeMemory(
				homesRoot,
				"exec-a",
				"extensions/ad_hoc/notes/note.md",
				"Direct note\n",
			);
			for (const excluded of [
				"auth.json",
				"config.toml",
				"memories_1.sqlite",
				"phase2_workspace_diff.md",
				"extensions/ad_hoc/instructions.md",
				"skills/nested/script.js",
			]) {
				writeMemory(homesRoot, "exec-a", excluded, "DO NOT COPY\n");
			}
			writeMemory(homesRoot, "exec-b", "MEMORY.md", "Conflicting B\n");
			const sources = [
				{
					executionId: "exec-a",
					issueId: "issue-a",
					issueIdentifier: "FLY-1",
					issueTitle: "First",
					startedAt: "2026-09-01T03:04:05Z",
				},
				{
					executionId: "exec-b",
					issueId: "issue-b",
					issueIdentifier: "FLY-2",
					issueTitle: "Second",
					startedAt: "2026-09-02T03:04:05Z",
				},
			];
			return publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: reverse ? sources.reverse() : sources,
				skipped: [{ executionId: "exec-z", reason: "missing_identity" }],
			});
		};

		const first = run(false);
		const second = run(true);
		expect(first.manifest.snapshots).toHaveLength(2);
		const sourceA = first.manifest.sources.find(
			(source) => source.executionId === "exec-a",
		);
		expect(
			first.manifest.snapshots
				.find((snapshot) => snapshot.hash === sourceA?.snapshotHash)
				?.files.map((file) => file.path),
		).toEqual([
			"MEMORY.md",
			"extensions/ad_hoc/notes/note.md",
			"memory_summary.md",
			"raw_memories.md",
			"rollout_summaries/a.md",
			"skills/nested/SKILL.md",
		]);
		expect(readTree(first.directory)).toEqual(readTree(second.directory));
	});

	it("rejects a symlinked whitelisted file without publishing a partial archive", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		const memories = join(homesRoot, "exec-a", "memories");
		mkdirSync(memories, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(join(root, "outside.md"), "outside\n");
		symlinkSync(join(root, "outside.md"), join(memories, "MEMORY.md"));

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			}),
		).toThrow("seed_unsafe_source");
		expect(existsSync(join(home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("rejects a broken symlink at a whitelisted path", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		const memories = join(homesRoot, "exec-a", "memories");
		mkdirSync(memories, { recursive: true });
		mkdirSync(home, { recursive: true });
		symlinkSync(join(root, "does-not-exist"), join(memories, "MEMORY.md"));

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			}),
		).toThrow("seed_unsafe_source");
	});

	it("rejects symlinked directories, traversal ids, and non-regular whitelist entries", () => {
		const inputFor = (root: string, executionId: string) => {
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			return {
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId,
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			};
		};

		const symlinkRoot = fixtureRoot();
		const symlinkInput = inputFor(symlinkRoot, "exec-a");
		const memories = join(symlinkInput.homesRoot, "exec-a", "memories");
		mkdirSync(memories, { recursive: true });
		mkdirSync(join(symlinkRoot, "outside"));
		symlinkSync(join(symlinkRoot, "outside"), join(memories, "skills"));
		expect(() => publishCodexMemorySeed(symlinkInput)).toThrow(
			"seed_unsafe_source",
		);

		for (const executionId of ["../escape", "/absolute"]) {
			expect(() =>
				publishCodexMemorySeed(inputFor(fixtureRoot(), executionId)),
			).toThrow("seed_unsafe_source");
		}

		const nonRegularRoot = fixtureRoot();
		const nonRegularInput = inputFor(nonRegularRoot, "exec-a");
		mkdirSync(
			join(nonRegularInput.homesRoot, "exec-a", "memories", "MEMORY.md"),
			{ recursive: true },
		);
		expect(() => publishCodexMemorySeed(nonRegularInput)).toThrow(
			"seed_unsafe_source",
		);
	});

	it("fails closed for unreadable and invalid UTF-8 memory files", () => {
		const makeInput = (content: Uint8Array) => {
			const root = fixtureRoot();
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			const memory = join(homesRoot, "exec-a", "memories", "MEMORY.md");
			mkdirSync(join(memory, ".."), { recursive: true });
			writeFileSync(memory, content);
			return {
				input: {
					home,
					homesRoot,
					project: "flywheel",
					role: "implement",
					sources: [
						{
							executionId: "exec-a",
							issueId: null,
							issueIdentifier: null,
							issueTitle: null,
							startedAt: null,
						},
					],
					skipped: [],
				},
				memory,
			};
		};

		const invalid = makeInput(Uint8Array.from([0xc3, 0x28]));
		expect(() => publishCodexMemorySeed(invalid.input)).toThrow(
			"seed_invalid_utf8",
		);
		const unreadable = makeInput(new TextEncoder().encode("private\n"));
		chmodSync(unreadable.memory, 0o000);
		expect(() => publishCodexMemorySeed(unreadable.input)).toThrow();
	});

	it("records missing and whitespace-only memories as no_memory", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-empty", "MEMORY.md", " \n\t");

		const result = publishCodexMemorySeed({
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: ["exec-missing", "exec-empty"].map((executionId) => ({
				executionId,
				issueId: null,
				issueIdentifier: null,
				issueTitle: null,
				startedAt: null,
			})),
			skipped: [],
		});

		expect(result.manifest.sources).toEqual([]);
		expect(result.manifest.snapshots).toEqual([]);
		expect(result.manifest.skipped).toEqual([
			{ executionId: "exec-empty", reason: "no_memory" },
			{ executionId: "exec-missing", reason: "no_memory" },
		]);
	});

	it("publishes and reuses a complete empty archive with private modes", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [],
			skipped: [],
		};
		const result = publishCodexMemorySeed(input);

		expect(statSync(result.directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(result.directory, "snapshots")).mode & 0o777).toBe(
			0o700,
		);
		for (const file of ["manifest.json", "index.md", "catalog.md"]) {
			expect(statSync(join(result.directory, file)).mode & 0o777).toBe(0o600);
		}
		expect(publishCodexMemorySeed(input).reused).toBe(true);
	});

	it("accepts a file at 2 MiB and rejects the next byte", () => {
		const makeInput = (bytes: number) => {
			const root = fixtureRoot();
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			writeMemory(homesRoot, "exec-a", "MEMORY.md", "x".repeat(bytes));
			return {
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			};
		};

		expect(
			publishCodexMemorySeed(makeInput(2 * 1024 * 1024)).manifest.sources,
		).toHaveLength(1);
		const over = makeInput(2 * 1024 * 1024 + 1);
		expect(() => publishCodexMemorySeed(over)).toThrow("seed_limit_exceeded");
		expect(existsSync(join(over.home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("fails closed when the source changes between the two scans", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "before\n");

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
				testing: {
					afterFirstScan: () =>
						writeMemory(homesRoot, "exec-a", "MEMORY.md", "after\n"),
				},
			}),
		).toThrow("seed_source_changed");
		expect(existsSync(join(home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("detects a changed whitelisted file even when both versions are empty memory", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", " \n");

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
				testing: {
					afterFirstScan: () =>
						writeMemory(homesRoot, "exec-a", "MEMORY.md", "\t\n"),
				},
			}),
		).toThrow("seed_source_changed");
		expect(existsSync(join(home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("accepts 32 MiB total and rejects one additional whitelisted file", () => {
		const makeInput = (fileCount: number) => {
			const root = fixtureRoot();
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			for (let index = 0; index < fileCount; index += 1) {
				writeMemory(
					homesRoot,
					"exec-a",
					`skills/file-${String(index).padStart(2, "0")}.md`,
					"x".repeat(2 * 1024 * 1024),
				);
			}
			return {
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			};
		};

		expect(publishCodexMemorySeed(makeInput(16)).manifest.sources).toHaveLength(
			1,
		);
		const over = makeInput(17);
		expect(() => publishCodexMemorySeed(over)).toThrow("seed_limit_exceeded");
		expect(existsSync(join(over.home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("accepts exactly 4096 files and rejects the next file", () => {
		const makeInput = (fileCount: number) => {
			const root = fixtureRoot();
			const homesRoot = join(root, "homes");
			const home = join(homesRoot, "agents", "flywheel", "implement");
			mkdirSync(home, { recursive: true });
			for (let index = 0; index < fileCount; index += 1) {
				writeMemory(
					homesRoot,
					"exec-a",
					`skills/${String(index).padStart(4, "0")}.md`,
					"x",
				);
			}
			return {
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
			};
		};

		expect(
			publishCodexMemorySeed(makeInput(4096)).manifest.sources,
		).toHaveLength(1);
		const over = makeInput(4097);
		expect(() => publishCodexMemorySeed(over)).toThrow("seed_limit_exceeded");
		expect(existsSync(join(over.home, ".flywheel-memory-seed"))).toBe(false);
	}, 60_000);

	it("keeps the startup index bounded while cataloging every production-scale snapshot", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		const sources = Array.from({ length: 225 }, (_, index) => {
			const uniqueIndex = index < 217 ? index : index - 217;
			const executionId = `exec-${String(index).padStart(3, "0")}`;
			writeMemory(
				homesRoot,
				executionId,
				"MEMORY.md",
				`memory-${uniqueIndex}\n`,
			);
			return {
				executionId,
				issueId: `issue-${index}`,
				issueIdentifier: index === 0 ? "FLY-OLD-TARGET" : `FLY-${1000 + index}`,
				issueTitle:
					index === 0
						? "ancient websocket handshake discovery"
						: `Historical task ${index}`,
				startedAt: new Date(
					Date.UTC(2025, 0, 1) + uniqueIndex * 86_400_000,
				).toISOString(),
			};
		});
		const skipped = Array.from({ length: 380 }, (_, index) => ({
			executionId: `skip-${String(index).padStart(3, "0")}`,
			reason: "no_memory",
		}));

		const result = publishCodexMemorySeed({
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources,
			skipped,
		});
		const index = readFileSync(join(result.directory, "index.md"), "utf8");
		const catalog = readFileSync(join(result.directory, "catalog.md"), "utf8");
		expect(Buffer.byteLength(index)).toBeLessThanOrEqual(8192);
		expect(index.match(/^- .*snapshots\//gm)?.length ?? 0).toBeLessThanOrEqual(
			8,
		);
		expect(index).not.toContain("FLY-OLD-TARGET");
		expect(catalog).toContain("FLY-OLD-TARGET");
		expect(catalog).toContain("ancient websocket handshake discovery");
		expect(result.manifest.sources).toHaveLength(225);
		expect(result.manifest.snapshots).toHaveLength(217);
		expect(result.manifest.skipped).toHaveLength(380);
	});

	it("reuses a valid archive without rescanning removed legacy sources", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "remembered\n");
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [
				{
					executionId: "exec-a",
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				},
			],
			skipped: [],
		};
		const first = publishCodexMemorySeed(input);
		rmSync(join(homesRoot, "exec-a"), { recursive: true });

		const reused = publishCodexMemorySeed(input);
		expect(reused.reused).toBe(true);
		expect(reused.manifest).toEqual(first.manifest);
	});

	it("rejects a completed archive whose snapshot bytes no longer match its manifest", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "remembered\n");
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [
				{
					executionId: "exec-a",
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				},
			],
			skipped: [],
		};
		const first = publishCodexMemorySeed(input);
		const snapshot = first.manifest.snapshots[0]!;
		writeFileSync(
			join(first.directory, "snapshots", snapshot.hash, "MEMORY.md"),
			"tampered!!\n",
		);

		expect(() => publishCodexMemorySeed(input)).toThrow(
			"invalid codex memory seed manifest",
		);
	});

	it("rejects a completed archive whose deterministic navigation was changed", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [],
			skipped: [],
		};
		const first = publishCodexMemorySeed(input);
		writeFileSync(join(first.directory, "index.md"), "changed\n");

		expect(() => publishCodexMemorySeed(input)).toThrow(
			"invalid codex memory seed manifest",
		);
	});

	it("rejects an unlisted file in a completed snapshot", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "remembered\n");
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [
				{
					executionId: "exec-a",
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				},
			],
			skipped: [],
		};
		const first = publishCodexMemorySeed(input);
		writeFileSync(
			join(
				first.directory,
				"snapshots",
				first.manifest.snapshots[0]!.hash,
				"unlisted.md",
			),
			"unlisted\n",
		);

		expect(() => publishCodexMemorySeed(input)).toThrow(
			"invalid codex memory seed manifest",
		);
	});

	it.each([
		[
			"a future manifest schema",
			(directory: string) => {
				const path = join(directory, "manifest.json");
				const manifest = JSON.parse(readFileSync(path, "utf8"));
				writeFileSync(path, `${JSON.stringify({ ...manifest, version: 2 })}\n`);
			},
		],
		[
			"a missing final manifest",
			(directory: string) => {
				rmSync(join(directory, "manifest.json"));
			},
		],
	])("rejects %s", (_label, corrupt) => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		const input = {
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [],
			skipped: [],
		};
		const first = publishCodexMemorySeed(input);
		corrupt(first.directory);

		expect(() => publishCodexMemorySeed(input)).toThrow(
			"invalid codex memory seed manifest",
		);
	});

	it("rejects duplicate execution identities instead of choosing metadata by input order", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "remembered\n");

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: ["First", "Conflicting"].map((issueTitle) => ({
					executionId: "exec-a",
					issueId: null,
					issueIdentifier: null,
					issueTitle,
					startedAt: null,
				})),
				skipped: [],
			}),
		).toThrow("seed_duplicate_execution");
	});

	it("uses the specified code-unit order for deterministic manifest arrays", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });

		const result = publishCodexMemorySeed({
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [],
			skipped: ["a", "B"].map((executionId) => ({
				executionId,
				reason: "no_memory",
			})),
		});

		expect(result.manifest.skipped.map((row) => row.executionId)).toEqual([
			"B",
			"a",
		]);
	});

	it("applies the 32 MiB cap across unique snapshots, not separately per source", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		for (let index = 0; index < 16; index += 1) {
			writeMemory(
				homesRoot,
				"exec-a",
				`skills/file-${String(index).padStart(2, "0")}.md`,
				"x".repeat(2 * 1024 * 1024),
			);
		}
		writeMemory(homesRoot, "exec-b", "MEMORY.md", "one more byte");

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: ["exec-a", "exec-b"].map((executionId) => ({
					executionId,
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				})),
				skipped: [],
			}),
		).toThrow("seed_limit_exceeded");
		expect(existsSync(join(home, ".flywheel-memory-seed"))).toBe(false);
	});

	it("normalizes only real UTC or explicitly zoned timestamps", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		for (const executionId of ["invalid-day", "local-time", "offset-time"]) {
			writeMemory(homesRoot, executionId, "MEMORY.md", `${executionId}\n`);
		}

		const result = publishCodexMemorySeed({
			home,
			homesRoot,
			project: "flywheel",
			role: "implement",
			sources: [
				["invalid-day", "2026-02-31T03:04:05Z"],
				["local-time", "2026-09-01T03:04:05"],
				["offset-time", "2026-09-01T03:04:05+09:00"],
			].map(([executionId, startedAt]) => ({
				executionId,
				issueId: null,
				issueIdentifier: null,
				issueTitle: null,
				startedAt,
			})),
			skipped: [],
		});
		expect(
			Object.fromEntries(
				result.manifest.sources.map((source) => [
					source.executionId,
					source.startedAt,
				]),
			),
		).toEqual({
			"invalid-day": null,
			"local-time": null,
			"offset-time": "2026-08-31T18:04:05.000Z",
		});
	});

	it("renders identical bytes in UTC, Tokyo, and Los Angeles", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		mkdirSync(homesRoot, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "timezone invariant\n");
		const worker = fileURLToPath(
			new URL("fixtures/codex-memory-seed-timezone-worker.ts", import.meta.url),
		);
		const outputs = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map(
			(timezone, index) => {
				const home = join(root, `target-${index}`);
				mkdirSync(home, { recursive: true });
				const input = {
					home,
					homesRoot,
					project: "flywheel",
					role: "implement",
					sources: [
						{
							executionId: "exec-a",
							issueId: "issue-a",
							issueIdentifier: "FLY-1",
							issueTitle: "Timezone",
							startedAt: "2026-07-19 18:36:36.052",
						},
					],
					skipped: [],
				};
				const child = spawnSync(
					process.execPath,
					["--import", "tsx", worker, JSON.stringify(input)],
					{
						cwd: join(fileURLToPath(new URL("..", import.meta.url))),
						env: { ...process.env, TZ: timezone },
						encoding: "utf8",
					},
				);
				expect(child.stderr).toBe("");
				expect(child.status).toBe(0);
				return child.stdout;
			},
		);
		expect(new Set(outputs).size).toBe(1);
		expect(outputs[0]).toContain("2026-07-19T18:36:36.052Z");
	}, 20_000);

	it("removes only its staging directory when publication fails", () => {
		const root = fixtureRoot();
		const homesRoot = join(root, "homes");
		const home = join(homesRoot, "agents", "flywheel", "implement");
		mkdirSync(home, { recursive: true });
		writeMemory(homesRoot, "exec-a", "MEMORY.md", "remembered\n");
		mkdirSync(join(home, ".flywheel-memory-seed.foreign.tmp"));

		expect(() =>
			publishCodexMemorySeed({
				home,
				homesRoot,
				project: "flywheel",
				role: "implement",
				sources: [
					{
						executionId: "exec-a",
						issueId: null,
						issueIdentifier: null,
						issueTitle: null,
						startedAt: null,
					},
				],
				skipped: [],
				testing: {
					beforeRename: () => {
						throw new Error("injected publish failure");
					},
				},
			}),
		).toThrow("injected publish failure");
		expect(readdirSync(home).sort()).toEqual([
			".flywheel-memory-seed.foreign.tmp",
		]);
	});
});
