import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	compileRetentionEntries,
	loadRetentionSnapshot,
} from "../../../../scripts/lib/fly-2006-retention-loader.mjs";
import {
	assertNoUnclassifiedSchema,
	createSchemaAssertions,
} from "../../../../scripts/lib/fly-2006-retention-registry.mjs";
import { MailboxQueue } from "../../../flywheel-comm/src/mailbox-queue.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
function fixture() {
	const moduleRoot = mkdtempSync(join(tmpdir(), "fly2413-loader-"));
	roots.push(moduleRoot);
	const root = join(moduleRoot, "fly-2006-retention-tables");
	for (const database of ["teamlead", "comm"]) {
		mkdirSync(join(root, database), { recursive: true });
		writeFileSync(
			join(root, database, "sample.json"),
			JSON.stringify({
				database,
				table: "sample",
				classification:
					database === "comm"
						? "protectedCurrentOrAuthority"
						: "protectedAuthority",
			}),
		);
	}
	for (const file of [
		"fly-2006-retention-loader.mjs",
		"fly-2006-retention-registry.mjs",
	])
		writeFileSync(join(moduleRoot, file), "// fixture source\n");
	return {
		root,
		moduleRoot,
		load: () => loadRetentionSnapshot(pathToFileURL(`${root}/`)),
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const a = {
	database: "comm",
	table: "required_a",
	classification: "protectedCurrentOrAuthority",
};
const b = {
	database: "comm",
	table: "required_b",
	classification: "deleteTarget",
};

describe("FLY-2413 strict retention fragments", () => {
	it("compiles independent additions as an ordered frozen union", () => {
		const union = compileRetentionEntries([b, a]);
		expect(union).toEqual(compileRetentionEntries([a, b]));
		expect(union.comm.protectedCurrentOrAuthority).toEqual(
			compileRetentionEntries([a]).comm.protectedCurrentOrAuthority,
		);
		expect(union.comm.deleteTarget).toEqual(
			compileRetentionEntries([b]).comm.deleteTarget,
		);
		expect(Object.isFrozen(union)).toBe(true);
		expect(Object.isFrozen(union.comm)).toBe(true);
		expect(Object.isFrozen(union.comm.deleteTarget)).toBe(true);
		expect(() => union.comm.deleteTarget.push("unexpected")).toThrow();
	});
	it("rejects duplicate identities even with identical classifications", () => {
		for (const duplicate of [a, { ...a, classification: "deleteTarget" }])
			expect(() => compileRetentionEntries([a, duplicate])).toThrow(
				"schema_registry_overlap:comm",
			);
		expect(() =>
			compileRetentionEntries([
				a,
				{ ...a, database: "teamlead", classification: "protectedAuthority" },
			]),
		).not.toThrow();
	});
	it.each([
		null,
		[],
		{},
		{ ...a, extra: true },
		{ ...a, database: "other" },
		{ ...a, database: "__proto__" },
		{ ...a, table: "sqlite_hidden" },
		{ ...a, table: "Upper" },
		{ ...a, table: 3 },
		{ ...a, classification: "protectedAuthority" },
		{ ...a, classification: "toString" },
	])("rejects malformed entry %j", (entry) => {
		expect(() => compileRetentionEntries([entry])).toThrow(
			"retention_entry_invalid",
		);
	});
	it("loads both database families and hashes source plus exact fragment bytes", () => {
		const f = fixture();
		const snapshot = f.load();
		expect(snapshot.classifications.comm.protectedCurrentOrAuthority).toEqual([
			"sample",
		]);
		expect(
			snapshot.inputs.map((input: { path: string }) => input.path),
		).toEqual([
			"fly-2006-retention-loader.mjs",
			"fly-2006-retention-registry.mjs",
			"fly-2006-retention-tables/comm/sample.json",
			"fly-2006-retention-tables/teamlead/sample.json",
		]);
		expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(snapshot.inputs[0])).toBe(true);
		const file = join(f.root, "comm/sample.json");
		renameSync(file, `${file}.tmp`);
		renameSync(`${file}.tmp`, file);
		expect(f.load().digest).toBe(snapshot.digest);
		writeFileSync(file, JSON.stringify({ ...a, table: "sample" }, null, 2));
		expect(f.load().digest).not.toBe(snapshot.digest);
	});
	it.each([
		[
			"missing",
			(f: ReturnType<typeof fixture>) => rmSync(f.root, { recursive: true }),
			"retention_path_invalid:fly-2006-retention-tables",
		],
		[
			"missing database",
			(f: ReturnType<typeof fixture>) =>
				rmSync(join(f.root, "comm"), { recursive: true }),
			"retention_path_invalid:fly-2006-retention-tables/comm",
		],
		[
			"empty",
			(f: ReturnType<typeof fixture>) =>
				rmSync(join(f.root, "comm/sample.json")),
			"retention_database_empty:comm",
		],
		[
			"extra directory",
			(f: ReturnType<typeof fixture>) => mkdirSync(join(f.root, "other")),
			"retention_path_invalid:fly-2006-retention-tables/other",
		],
		[
			"extra file",
			(f: ReturnType<typeof fixture>) =>
				writeFileSync(join(f.root, "comm/extra.txt"), "x"),
			"retention_path_invalid:fly-2006-retention-tables/comm/extra.txt",
		],
		[
			"dotfile",
			(f: ReturnType<typeof fixture>) =>
				writeFileSync(join(f.root, "comm/.DS_Store"), "x"),
			"retention_path_invalid:fly-2006-retention-tables/comm/.DS_Store",
		],
		[
			"nested",
			(f: ReturnType<typeof fixture>) =>
				mkdirSync(join(f.root, "comm/nested.json")),
			"retention_path_invalid:fly-2006-retention-tables/comm/nested.json",
		],
		[
			"symlink",
			(f: ReturnType<typeof fixture>) =>
				symlinkSync(
					join(f.root, "comm/sample.json"),
					join(f.root, "comm/link.json"),
				),
			"retention_path_invalid:fly-2006-retention-tables/comm/link.json",
		],
		[
			"bad JSON",
			(f: ReturnType<typeof fixture>) =>
				writeFileSync(join(f.root, "comm/sample.json"), "{ secret"),
			"retention_json_invalid:fly-2006-retention-tables/comm/sample.json",
		],
		[
			"wrong identity",
			(f: ReturnType<typeof fixture>) =>
				writeFileSync(join(f.root, "comm/sample.json"), JSON.stringify(a)),
			"retention_identity_mismatch:fly-2006-retention-tables/comm/sample.json",
		],
	])("rejects %s with a stable relative path", (_name, mutate, error) => {
		const f = fixture();
		mutate(f);
		expect(f.load).toThrow(error);
	});
});

describe("independent schema observations", () => {
	it("rejects missing required tables from an independent actual list", () => {
		const guard = createSchemaAssertions(compileRetentionEntries([a, b]));
		expect(() => guard.assertClassifiedSchema("comm", ["required_a"])).toThrow(
			"schema_missing:comm:required_b",
		);
		expect(() =>
			guard.assertClassifiedSchema("comm", ["required_a", "required_b"]),
		).not.toThrow();
	});
	it("rejects unknown tables and unknown databases", () => {
		const guard = createSchemaAssertions(compileRetentionEntries([a, b]));
		expect(() =>
			guard.assertClassifiedSchema("comm", [
				"required_a",
				"required_b",
				"unexpected",
			]),
		).toThrow("schema_unclassified:comm:unexpected");
		for (const database of ["other", "__proto__", "constructor"])
			expect(() => guard.assertNoUnclassifiedSchema(database, [])).toThrow(
				`unknown_retention_database:${database}`,
			);
	});
	it("allows optional retired tables to be absent or present", () => {
		const guard = createSchemaAssertions(
			compileRetentionEntries([
				{
					database: "teamlead",
					table: "historical",
					classification: "retiredOptional",
				},
			]),
		);
		expect(() => guard.assertClassifiedSchema("teamlead", [])).not.toThrow();
		expect(() =>
			guard.assertClassifiedSchema("teamlead", ["historical"]),
		).not.toThrow();
	});
	it("rejects overlap in a supplied classification model", () => {
		const guard = createSchemaAssertions({
			comm: { deleteTarget: ["same"], protectedCurrentOrAuthority: ["same"] },
		});
		expect(() => guard.assertClassifiedSchema("comm", ["same"])).toThrow(
			"schema_registry_overlap:comm",
		);
	});
});

describe("independent initialized schemas", () => {
	it("classifies the current production schemas created for both live database families", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-live-schema-"));
		const teamleadPath = join(root, "teamlead.db");
		const commPath = join(root, "comm.db");
		try {
			const store = await StateStore.create(teamleadPath);
			store.close();
			const queue = new MailboxQueue(commPath);
			queue.close();

			for (const [database, path] of [
				["teamlead", teamleadPath],
				["comm", commPath],
			] as const) {
				const sqlite = new Database(path, { readonly: true });
				try {
					const tables = sqlite
						.prepare(
							"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
						)
						.all()
						.map((row) => String((row as { name: string }).name));
					expect(() =>
						assertNoUnclassifiedSchema(database, tables),
					).not.toThrow();
				} finally {
					sqlite.close();
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a real unregistered table and recovers after removing it", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2413-schema-"));
		roots.push(root);
		const path = join(root, "teamlead.db");
		const store = await StateStore.create(path);
		store.close();
		const db = new Database(path);
		try {
			const tables = () =>
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
					)
					.all()
					.map((r) => (r as { name: string }).name);
			expect(() =>
				assertNoUnclassifiedSchema("teamlead", tables()),
			).not.toThrow();
			db.exec(
				"CREATE TABLE fly2413_unregistered_probe(id INTEGER PRIMARY KEY)",
			);
			expect(() => assertNoUnclassifiedSchema("teamlead", tables())).toThrow(
				"schema_unclassified:teamlead:fly2413_unregistered_probe",
			);
			db.exec("DROP TABLE fly2413_unregistered_probe");
			expect(() =>
				assertNoUnclassifiedSchema("teamlead", tables()),
			).not.toThrow();
		} finally {
			db.close();
		}
	});
});

describe("fragment input lifecycle and parallel merge", () => {
	it("runs an unchanged shared test for a simulated third-party schema and fragment addition", () => {
		const f = fixture();
		const loaderUrl = new URL(
			"../../../../scripts/lib/fly-2006-retention-loader.mjs",
			import.meta.url,
		).href;
		const registryUrl = new URL(
			"../../../../scripts/lib/fly-2006-retention-registry.mjs",
			import.meta.url,
		).href;
		const testPath = join(f.moduleRoot, "shared-schema.test.mjs");
		const sqlPath = join(f.moduleRoot, "schema.sql");
		// This executable test has no expected table list. Schema SQL is independent
		// of classification data, as it would be in a feature PR.
		const source = `import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadRetentionSnapshot } from ${JSON.stringify(loaderUrl)};
import { createSchemaAssertions } from ${JSON.stringify(registryUrl)};
const Database = createRequire(${JSON.stringify(import.meta.url)})('better-sqlite3');
test('all actual tables have independently declared retention', () => {
  const db = new Database(':memory:');
  try {
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const snapshot = loadRetentionSnapshot(new URL('./fly-2006-retention-tables/', import.meta.url));
    createSchemaAssertions(snapshot.classifications).assertClassifiedSchema('comm', actual);
  } finally { db.close(); }
});
`;
		writeFileSync(testPath, source);
		writeFileSync(sqlPath, "CREATE TABLE sample(id INTEGER);");
		const run = () =>
			spawnSync(process.execPath, ["--test", testPath], {
				encoding: "utf8",
				timeout: 30_000,
			});
		const baseline = run();
		expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
		writeFileSync(
			sqlPath,
			"CREATE TABLE sample(id INTEGER); CREATE TABLE third_party_feature(id INTEGER);",
		);
		const unregistered = run();
		expect(unregistered.status).toBe(1);
		expect(unregistered.stdout + unregistered.stderr).toContain(
			"schema_unclassified:comm:third_party_feature",
		);
		// A third-party PR supplies only its schema and its own fragment.
		const fragment = join(f.root, "comm/third_party_feature.json");
		writeFileSync(
			fragment,
			JSON.stringify({
				database: "comm",
				table: "third_party_feature",
				classification: "protectedCurrentOrAuthority",
			}),
		);
		const registered = run();
		expect(registered.status, registered.stdout + registered.stderr).toBe(0);
		expect(readFileSync(testPath, "utf8")).toBe(source);
		rmSync(fragment);
		const lostFragment = run();
		expect(lostFragment.status).toBe(1);
		expect(lostFragment.stdout + lostFragment.stderr).toContain(
			"schema_unclassified:comm:third_party_feature",
		);
		expect(readFileSync(testPath, "utf8")).toBe(source);
	});
	it("changes the digest for add/remove and source edits, independent of enumeration order", () => {
		const f = fixture();
		const baseline = f.load();
		const extra = join(f.root, "comm/required_b.json");
		writeFileSync(extra, JSON.stringify(b));
		const added = f.load();
		expect(added.digest).not.toBe(baseline.digest);
		rmSync(extra);
		expect(f.load().digest).toBe(baseline.digest);
		writeFileSync(
			join(f.moduleRoot, "fly-2006-retention-loader.mjs"),
			"// changed loader\n",
		);
		expect(f.load().digest).not.toBe(baseline.digest);
		writeFileSync(
			join(f.moduleRoot, "fly-2006-retention-loader.mjs"),
			"// fixture source\n",
		);
		writeFileSync(
			join(f.moduleRoot, "fly-2006-retention-registry.mjs"),
			"// changed registry\n",
		);
		expect(f.load().digest).not.toBe(baseline.digest);
	});
	it.each(["root", "database", "source"])("rejects a symlink at %s", (kind) => {
		const f = fixture();
		const path =
			kind === "root"
				? f.root
				: kind === "database"
					? join(f.root, "comm")
					: join(f.moduleRoot, "fly-2006-retention-loader.mjs");
		renameSync(path, `${path}-original`);
		symlinkSync(`${path}-original`, path);
		expect(f.load).toThrow("retention_path_invalid:");
	});
	it("merges independent A/B fragment additions without editing the common guard, and rejects a lost fragment", () => {
		const f = fixture();
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: f.moduleRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git("init");
		git("config", "user.name", "Retention fixture");
		git("config", "user.email", "retention-fixture@example.invalid");
		const guardPath = join(f.moduleRoot, "common-guard.mjs");
		const guardSource = readFileSync(
			new URL(
				"../../../../scripts/lib/fly-2006-retention-registry.mjs",
				import.meta.url,
			),
			"utf8",
		);
		writeFileSync(guardPath, guardSource);
		git("add", ".");
		git("commit", "-m", "fixture baseline");
		const base = git("rev-parse", "HEAD");
		git("checkout", "-b", "addition-a");
		writeFileSync(join(f.root, "comm/required_a.json"), JSON.stringify(a));
		git("add", ".");
		git("commit", "-m", "add A");
		git("checkout", "-b", "addition-b", base);
		writeFileSync(
			join(f.root, "comm/required_b.json"),
			JSON.stringify({ ...b, classification: "protectedCurrentOrAuthority" }),
		);
		git("add", ".");
		git("commit", "-m", "add B");
		git("merge", "--no-edit", "addition-a");
		expect(git("diff", "--name-only", base).split("\n")).toEqual([
			"fly-2006-retention-tables/comm/required_a.json",
			"fly-2006-retention-tables/comm/required_b.json",
		]);
		expect(readFileSync(guardPath, "utf8")).toBe(guardSource);
		const merged = f.load();
		expect(merged.classifications.comm.deleteTarget).toEqual([]);
		expect(merged.classifications.comm.protectedCurrentOrAuthority).toEqual([
			"required_a",
			"required_b",
			"sample",
		]);
		const db = new Database(join(f.moduleRoot, "merged.db"));
		try {
			db.exec(
				"CREATE TABLE sample(id INTEGER); CREATE TABLE required_a(id INTEGER); CREATE TABLE required_b(id INTEGER)",
			);
			const actual = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((r) => (r as { name: string }).name);
			expect(() =>
				createSchemaAssertions(merged.classifications).assertClassifiedSchema(
					"comm",
					actual,
				),
			).not.toThrow();
			rmSync(join(f.root, "comm/required_b.json"));
			expect(() =>
				createSchemaAssertions(
					f.load().classifications,
				).assertNoUnclassifiedSchema("comm", actual),
			).toThrow("schema_unclassified:comm:required_b");
		} finally {
			db.close();
		}
	});
});
