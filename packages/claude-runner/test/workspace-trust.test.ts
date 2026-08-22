/** FLY-1961: pre-launch Claude workspace trust provisioning. */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pretrustClaudeWorkspace } from "../src/workspace-trust.js";

let dir: string;
let claudeJson: string;
let lock: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1961-claude-trust-"));
	claudeJson = join(dir, ".claude.json");
	lock = join(dir, "custom-claude-json.lock");
	env = {
		FLYWHEEL_CLAUDE_JSON: claudeJson,
		FLYWHEEL_CLAUDE_JSON_LOCK: lock,
		CLAUDE_LOCK_WAIT_S: "0",
		CLAUDE_LOCK_STALE_S: "60",
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function readState(): Record<string, unknown> {
	return JSON.parse(readFileSync(claudeJson, "utf8")) as Record<
		string,
		unknown
	>;
}

describe("pretrustClaudeWorkspace", () => {
	it("creates a missing state file with the exact trusted workspace", async () => {
		const workspace = join(dir, "project-FLY-1961");

		await expect(pretrustClaudeWorkspace(workspace, env)).resolves.toBe(
			"written",
		);

		expect(readState()).toEqual({
			projects: {
				[workspace]: { hasTrustDialogAccepted: true },
			},
		});
		expect(statSync(claudeJson).mode & 0o777).toBe(0o600);
		expect(existsSync(lock)).toBe(false);
	});

	it("preserves unrelated state and is byte-idempotent once trusted", async () => {
		const workspace = join(dir, "project-FLY-1961");
		writeFileSync(
			claudeJson,
			JSON.stringify({
				keep: { nested: 1 },
				projects: { "/existing": { hasTrustDialogAccepted: false, keep: 2 } },
			}),
		);

		await expect(pretrustClaudeWorkspace(workspace, env)).resolves.toBe(
			"written",
		);
		const written = readFileSync(claudeJson, "utf8");
		await expect(pretrustClaudeWorkspace(workspace, env)).resolves.toBe(
			"already_trusted",
		);

		expect(readFileSync(claudeJson, "utf8")).toBe(written);
		expect(readState()).toMatchObject({
			keep: { nested: 1 },
			projects: {
				"/existing": { hasTrustDialogAccepted: false, keep: 2 },
				[workspace]: { hasTrustDialogAccepted: true },
			},
		});
	});

	it("serializes concurrent writers without dropping either trust entry", async () => {
		await Promise.all([
			pretrustClaudeWorkspace(join(dir, "a"), {
				...env,
				CLAUDE_LOCK_WAIT_S: "2",
			}),
			pretrustClaudeWorkspace(join(dir, "b"), {
				...env,
				CLAUDE_LOCK_WAIT_S: "2",
			}),
		]);

		expect(Object.keys(readState().projects as object).sort()).toEqual([
			join(dir, "a"),
			join(dir, "b"),
		]);
	});

	it("re-reads and merges when an external writer changes the source before commit", async () => {
		const workspace = join(dir, "project-FLY-1961");
		writeFileSync(claudeJson, JSON.stringify({ keep: "initial" }));
		let checks = 0;

		await expect(
			pretrustClaudeWorkspace(workspace, env, {
				beforeSourceCheck: async () => {
					checks += 1;
					if (checks === 1) {
						writeFileSync(
							claudeJson,
							JSON.stringify({
								externalWriter: { preserved: true },
								projects: {
									"/external": { hasTrustDialogAccepted: false },
								},
							}),
						);
					}
				},
			}),
		).resolves.toBe("written");

		expect(checks).toBe(2);
		expect(readState()).toMatchObject({
			externalWriter: { preserved: true },
			projects: {
				"/external": { hasTrustDialogAccepted: false },
				[workspace]: { hasTrustDialogAccepted: true },
			},
		});
	});

	it("fails closed after bounded continuous external source drift", async () => {
		const workspace = join(dir, "project-FLY-1961");
		writeFileSync(claudeJson, "{}\n");
		let checks = 0;

		await expect(
			pretrustClaudeWorkspace(workspace, env, {
				beforeSourceCheck: async () => {
					checks += 1;
					writeFileSync(
						claudeJson,
						`${JSON.stringify({ revision: checks })}\n`,
					);
				},
			}),
		).rejects.toThrow(/source kept changing after 5 merge attempts/);

		expect(checks).toBe(5);
		expect(readState()).toEqual({ revision: 5 });
	});

	it("honors an explicit lock path independently from the JSON path", async () => {
		mkdirSync(`${claudeJson}.lock`);

		await expect(
			pretrustClaudeWorkspace(join(dir, "explicit-lock"), env),
		).resolves.toBe("written");
		expect(existsSync(`${claudeJson}.lock`)).toBe(true);
	});

	it("recovers an aged bare lock directory but does not steal a fresh one", async () => {
		mkdirSync(lock);
		const old = new Date(Date.now() - 120_000);
		utimesSync(lock, old, old);

		await expect(
			pretrustClaudeWorkspace(join(dir, "stale-recovered"), env),
		).resolves.toBe("written");

		mkdirSync(lock);
		await expect(
			pretrustClaudeWorkspace(join(dir, "fresh-refused"), env),
		).rejects.toThrow(/timed out waiting for .*custom-claude-json\.lock/);
	});

	it("preserves the mode of an existing state file", async () => {
		writeFileSync(claudeJson, "{}\n");
		chmodSync(claudeJson, 0o644);

		await pretrustClaudeWorkspace(join(dir, "preserve-mode"), env);

		expect(statSync(claudeJson).mode & 0o777).toBe(0o644);
	});

	it.each([
		["invalid JSON", "{not-json", /valid JSON/],
		["array root", "[]", /root must be a plain object/],
		["array projects", '{"projects":[]}', /projects must be a plain object/],
	])(
		"fails loudly on %s without changing original bytes",
		async (_, raw, error) => {
			const workspace = join(dir, "invalid-state");
			writeFileSync(claudeJson, raw);

			await expect(pretrustClaudeWorkspace(workspace, env)).rejects.toThrow(
				error,
			);

			expect(readFileSync(claudeJson, "utf8")).toBe(raw);
		},
	);

	it("fails loudly on a scalar target entry without changing bytes", async () => {
		const workspace = join(dir, "scalar-entry");
		const raw = JSON.stringify({ projects: { [workspace]: "bad" } });
		writeFileSync(claudeJson, raw);

		await expect(pretrustClaudeWorkspace(workspace, env)).rejects.toThrow(
			/project entry must be a plain object/,
		);
		expect(readFileSync(claudeJson, "utf8")).toBe(raw);
	});

	it.each(["relative/path", `/tmp/bad\0path`])(
		"rejects unsafe workspace path %j before touching state",
		async (workspace) => {
			await expect(pretrustClaudeWorkspace(workspace, env)).rejects.toThrow(
				/must be absolute and NUL-free/,
			);
			expect(existsSync(claudeJson)).toBe(false);
		},
	);
});
