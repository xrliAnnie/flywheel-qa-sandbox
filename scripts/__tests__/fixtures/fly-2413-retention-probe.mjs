// Runs unchanged against normal and mutated isolated module trees.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, scenario, action] = process.argv.slice(2);
const lib = join(root, "scripts/lib");
const registry = await import(
	pathToFileURL(join(lib, "fly-2006-retention-registry.mjs"))
);
const loader = await import(
	pathToFileURL(join(lib, "fly-2006-retention-loader.mjs"))
);
const fragment = join(lib, "fly-2006-retention-tables/teamlead/sessions.json");
function changeFragment() {
	const entry = JSON.parse(readFileSync(fragment, "utf8"));
	entry.classification =
		entry.classification === "protectedAuthority"
			? "protectedCurrentOrReference"
			: "protectedAuthority";
	writeFileSync(fragment, JSON.stringify(entry, null, "\t") + "\n");
}
const Database = createRequire(join(root, "packages/teamlead/package.json"))(
	"better-sqlite3",
);
if (scenario === "missing") {
	const guard = registry.createSchemaAssertions(
		loader.compileRetentionEntries([
			{
				database: "comm",
				table: "required_a",
				classification: "protectedCurrentOrAuthority",
			},
			{ database: "comm", table: "required_b", classification: "deleteTarget" },
		]),
	);
	assert.throws(
		() => guard.assertClassifiedSchema("comm", ["required_a"]),
		/schema_missing:comm:required_b/,
	);
} else if (scenario === "unknown") {
	const { StateStore } = await import(
		pathToFileURL(join(root, "packages/teamlead/dist/StateStore.js"))
	);
	const path = join(root, "probe.db");
	const store = await StateStore.create(path);
	store.close();
	const db = new Database(path);
	try {
		const names = () =>
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
				)
				.all()
				.map((r) => r.name);
		assert.doesNotThrow(() =>
			registry.assertNoUnclassifiedSchema("teamlead", names()),
		);
		db.exec("CREATE TABLE fly2413_unregistered_probe(id INTEGER PRIMARY KEY)");
		assert.throws(
			() => registry.assertNoUnclassifiedSchema("teamlead", names()),
			/schema_unclassified:teamlead:fly2413_unregistered_probe/,
		);
		db.exec("DROP TABLE fly2413_unregistered_probe");
		assert.doesNotThrow(() =>
			registry.assertNoUnclassifiedSchema("teamlead", names()),
		);
	} finally {
		db.close();
	}
} else if (scenario === "cached") {
	const original = registry.retentionRegistryDigest();
	changeFragment();
	assert.throws(
		() => registry.retentionRegistryDigest(),
		/registry_inputs_changed/,
	);
	assert.match(original, /^[a-f0-9]{64}$/);
} else {
	const engine = await import(
		pathToFileURL(join(lib, "fly-2006-retention-engine.mjs"))
	);
	const homeDir = join(root, "home");
	const activationReceiptPath = join(
		homeDir,
		".flywheel/state/log-janitor/db-retention-activation.json",
	);
	const manifestPath = join(root, "evidence/manifest.json");
	const audit = {
		source: "discord-message",
		channelId: "10000000000000001",
		messageId: "10000000000000002",
		authorId: "10000000000000003",
		respondedAt: "2026-08-23T00:00:00.000Z",
		responseDigest: "a".repeat(64),
	};
	if (action === "prepare") {
		if (scenario === "activation") {
			mkdirSync(join(homeDir, ".flywheel/state/log-janitor"), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(
				activationReceiptPath,
				JSON.stringify({
					...engine.fly2139ActivationRequirements(),
					approvedBy: "flywheel-eng-lead",
					approvedAt: "2026-08-29T06:00:00.000Z",
				}) + "\n",
				{ mode: 0o600 },
			);
			assert.doesNotThrow(() =>
				engine.validateFly2139ActivationReceipt({
					homeDir,
					activationReceiptPath,
				}),
			);
		} else {
			const teamleadDbPath = join(root, "teamlead.db"),
				commDbPath = join(root, "comm.db");
			const db = new Database(teamleadDbPath);
			db.exec(
				"CREATE TABLE legacy_render_fallback(seq INTEGER PRIMARY KEY, fell_back_at TEXT NOT NULL); INSERT INTO legacy_render_fallback VALUES(1, '2000-01-01T00:00:00.000Z');",
			);
			db.close();
			new Database(commDbPath).close();
			const inventory = await engine.executeFly2006Inventory({
				teamleadDbPath,
				commDbPath,
				evidenceDir: join(root, "evidence"),
				allowFixturePaths: true,
				allowFixtureSchema: true,
			});
			assert.equal(
				inventory.manifest.targets.legacyRenderFallback.candidateCount,
				1,
			);
		}
	} else if (action === "change") {
		changeFragment();
	} else if (scenario === "activation") {
		// Isolate registrySha256 from the independently tested engineSha256 field.
		if (action === "reject-registry") {
			const receipt = JSON.parse(readFileSync(activationReceiptPath, "utf8"));
			receipt.engineSha256 =
				engine.fly2139ActivationRequirements().engineSha256;
			writeFileSync(activationReceiptPath, JSON.stringify(receipt) + "\n");
		}

		if (action === "reject" || action === "reject-registry")
			assert.throws(
				() =>
					engine.validateFly2139ActivationReceipt({
						homeDir,
						activationReceiptPath,
					}),
				/activation_receipt_invalid/,
			);
		else
			assert.doesNotThrow(() =>
				engine.validateFly2139ActivationReceipt({
					homeDir,
					activationReceiptPath,
				}),
			);
	} else {
		const apply = () =>
			engine.executeFly2006Apply({
				manifestPath,
				founderGateAudit: audit,
				allowFixturePaths: true,
			});
		if (action === "reject")
			await assert.rejects(apply, /engine_digest_mismatch/);
		else {
			const result = await apply();
			assert.equal(result.deleted.legacyRenderFallback, 1);
		}
		const db = new Database(join(root, "teamlead.db"), { readonly: true });
		try {
			assert.equal(
				db.prepare("SELECT count(*) AS count FROM legacy_render_fallback").get()
					.count,
				action === "reject" ? 1 : 0,
			);
		} finally {
			db.close();
		}
	}
}
console.log(`probe passed: ${scenario} ${action ?? ""}`);
