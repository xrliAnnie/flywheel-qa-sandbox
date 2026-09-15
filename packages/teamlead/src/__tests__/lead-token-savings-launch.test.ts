import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readLeadTokenSavingsAtLaunch } from "../lead-token-savings.js";

it("reads the shared project flag without migrating or writing the database", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-launch-read-"));
	const path = join(root, "flags.db");
	const db = new Database(path);
	try {
		db.exec(
			"CREATE TABLE flag_values(flag_name TEXT, scope TEXT, has_override INTEGER, raw_value TEXT)",
		);
		const read = (project = "flywheel") =>
			readLeadTokenSavingsAtLaunch(project, path);
		expect(read()).toBe(true);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_token_savings",
			"*",
			"0",
		);
		expect(read()).toBe(false);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_token_savings",
			"flywheel",
			"1",
		);
		const before = readFileSync(path);
		expect(read()).toBe(true);
		expect(read("another-project")).toBe(false);
		expect(readFileSync(path)).toEqual(before);
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
		).toEqual([{ name: "flag_values" }]);
		db.prepare(
			"UPDATE flag_values SET raw_value='0' WHERE scope='flywheel'",
		).run();
		expect(read()).toBe(false);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("selects full behavior for absent or malformed stores without creating a database", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-launch-unavailable-"));
	const path = join(root, "flags.db");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(readLeadTokenSavingsAtLaunch("flywheel", path)).toBe(false);
		expect(existsSync(path)).toBe(false);
		const db = new Database(path);
		db.exec(
			"CREATE TABLE flag_values(flag_name TEXT, scope TEXT, has_override INTEGER, raw_value TEXT)",
		);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_token_savings",
			"flywheel",
			"invalid",
		);
		db.close();
		expect(readLeadTokenSavingsAtLaunch("flywheel", path)).toBe(false);
		expect(warn).toHaveBeenCalled();
	} finally {
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

it("OFF selects original rule bytes through the shared Claude and Codex selectors", () => {
	const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
	const base = fileURLToPath(
		new URL("../../lead-rules-base/", import.meta.url),
	).replace(/\/$/, "");
	const receipt = JSON.parse(
		readFileSync(
			new URL(
				"../../../../engineering/doc/FLY-2567-lead-token-savings/evidence/rework-legacy-sources.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { sources: { path: string; sha256: string }[] };
	const selected = execFileSync(
		"bash",
		[
			"-c",
			'source "$1/lead-rules-bundle.sh"; _LEAD_TOKEN_SAVINGS_LAUNCH=0; FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1; compute_lead_rule_bundle dept "$2" mailbox 1 || exit $?; rules_bundle_reset; rules_bundle_add "$1/inbox-ack-rule.md" launcher || exit $?; printf "%s\n" "${RULES_BUNDLE_FILES[@]}"',
			"fixture",
			scripts,
			base,
		],
		{ encoding: "utf8", env: { ...process.env, BASH_ENV: "/dev/null" } },
	)
		.trim()
		.split("\n");
	for (const name of [
		"department-lead-rules.md",
		"runner-messaging-rules.md",
		"runner-patrol-rules.md",
		"inbox-ack-rule.md",
	]) {
		const expected = receipt.sources.find((entry) =>
			entry.path.endsWith(`/${name}`),
		)!;
		const path = selected.find((entry) => entry.endsWith(`/${name}`))!;
		expect(path).toBeDefined();
		expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
			expected.sha256,
		);
	}
});

it("OFF refuses a missing legacy asset instead of silently launching shortened rules", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-missing-legacy-"));
	try {
		const base = join(root, "lead-rules-base");
		mkdirSync(base);
		writeFileSync(join(base, "department-lead-rules.md"), "short rules");
		const result = spawnSync(
			"bash",
			[
				"-c",
				'source "$1"; _LEAD_TOKEN_SAVINGS_LAUNCH=0; rules_bundle_reset; rules_bundle_add "$2/department-lead-rules.md" governance',
				"fixture",
				fileURLToPath(
					new URL("../../scripts/lead-rules-bundle.sh", import.meta.url),
				),
				base,
			],
			{ encoding: "utf8", env: { ...process.env, BASH_ENV: "/dev/null" } },
		);
		expect(result.status).toBe(10);
		expect(result.stderr).toContain("MISSING_REQUIRED_LEGACY:");
		expect(result.stdout).toBe("");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("materializes the entire OFF governance body byte-for-byte as the historical shared launcher", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-full-bundle-"));
	try {
		const teamlead = fileURLToPath(new URL("../../", import.meta.url));
		const output = join(root, "bundle.md");
		execFileSync(
			"bash",
			[
				"-c",
				'source "$1/scripts/lead-rules-bundle.sh"; _LEAD_TOKEN_SAVINGS_LAUNCH=0; FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1; rules_bundle_reset; while IFS= read -r path; do rules_bundle_add "$path" governance || exit $?; done < <(compute_lead_rule_bundle dept "$1/lead-rules-base" mailbox 1); rules_bundle_add "$1/scripts/inbox-ack-rule.md" launcher || exit $?; rules_bundle_materialize "$2" dept fixture flywheel',
				"fixture",
				teamlead.replace(/\/$/, ""),
				output,
			],
			{ env: { ...process.env, BASH_ENV: "/dev/null" } },
		);
		const bytes = readFileSync(output);
		const body = bytes.subarray(bytes.indexOf(Buffer.from("═══ RULE SOURCE")));
		const original = JSON.parse(
			readFileSync(
				new URL("./fixtures/fly2567/legacy-bundle.json", import.meta.url),
				"utf8",
			),
		);
		expect(body.length).toBe(original.bodyBytes);
		expect(createHash("sha256").update(body).digest("hex")).toBe(
			original.sha256,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
