import { spawnSync } from "node:child_process";
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
import { expect, it } from "vitest";

it.each(["founder-time", "--help", "qa-result", "complete"])(
	"%s replays queued stages first and preserves pending terminal overtakes",
	(command) => {
		const home = mkdtempSync(join(tmpdir(), "fly1956-cli-drain-"));
		const dir = join(home, ".flywheel", "state", "stage-queue", "flag-exec");
		mkdirSync(dir, { recursive: true });
		const queueFile = join(dir, "000001-event.json");
		writeFileSync(
			queueFile,
			JSON.stringify({
				event_id: "event",
				execution_id: "flag-exec",
				issue_id: "FLY-1956",
				project_name: "flywheel",
				event_type: "stage_changed",
				source: "flywheel-comm",
				payload: { stage: "test" },
				queued_at: new Date().toISOString(),
			}),
		);
		const callsFile = join(home, "calls.jsonl");
		const preload = join(home, "fetch.mjs");
		writeFileSync(
			preload,
			`import {appendFileSync} from 'node:fs';
globalThis.fetch = async (url, init) => {
 const body = JSON.parse(init.body); appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(body)+'\\n');
 return new Response(JSON.stringify(body.event_type === 'stage_changed' ? ${command === "founder-time" || command === "--help" ? "{ok:true,applied:true}" : "{ok:true,duplicate:true}"} : {ok:true,claimId:1,serverSeq:2,idempotentReplay:true}));
};`,
		);
		const args =
			command === "founder-time" || command === "--help"
				? [command, "--json"]
				: command === "qa-result"
					? [
							command,
							"--exec-id",
							"flag-exec",
							"--target-exec",
							"impl",
							"--status",
							"pass",
						]
					: [command, "--route", "blocked", "--summary", "fixture"];
		try {
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					preload,
					new URL("../index.ts", import.meta.url).pathname,
					...args,
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: home,
						FLYWHEEL_EXEC_ID:
							command === "qa-result" ? "wrong-env" : "flag-exec",
						FLYWHEEL_COMM_DB: join(home, "comm.db"),
						FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
						FLYWHEEL_PROJECT_NAME: "flywheel",
						FLYWHEEL_ISSUE_ID: "FLY-1956",
						FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "fixture-credential",
					},
					encoding: "utf8",
					timeout: 15_000,
				},
			);
			expect(child.status, child.stderr).toBe(0);
			const calls = existsSync(callsFile)
				? readFileSync(callsFile, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
			expect(calls[0]).toMatchObject({
				event_id: "event",
				execution_id: "flag-exec",
				event_type: "stage_changed",
			});
			if (command === "founder-time" || command === "--help")
				expect(existsSync(queueFile)).toBe(false);
			else {
				expect(child.stderr).toContain("STAGE_PENDING_OVERTAKE");
				expect(existsSync(queueFile)).toBe(true);
				expect(calls).toHaveLength(2);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	},
	20_000,
);

it.each([
	["gate", "wrong-env-exec"],
	["gate", ""],
	["request-review", "wrong-env-exec"],
	["request-review", ""],
])(
	"%s uses flag exec with env=%s and refuses pending stage before durable writes",
	(command, envExecId) => {
		const home = mkdtempSync(join(tmpdir(), "fly1956-cli-fence-"));
		const dir = join(home, ".flywheel", "state", "stage-queue", "flag-exec");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "000001-event.json"),
			JSON.stringify({
				event_id: "event",
				execution_id: "flag-exec",
				issue_id: "FLY-1956",
				project_name: "flywheel",
				event_type: "stage_changed",
				source: "flywheel-comm",
				payload: { stage: "code_review" },
				queued_at: new Date().toISOString(),
			}),
		);
		const preload = join(home, "fetch.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/events') ? {ok:true,duplicate:true} : {accepted:true,requestId:'review-request'}));`,
		);
		const dbPath = join(home, "comm.db");
		const args =
			command === "gate"
				? [
						"gate",
						"review_code",
						"--lead",
						"test-lead",
						"--exec-id",
						"flag-exec",
						"--no-block",
						"Review this",
					]
				: [
						"request-review",
						"--type",
						"code",
						"--question-id",
						"question",
						"--exec-id",
						"flag-exec",
						"--request-id",
						"review-request",
					];
		try {
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					preload,
					new URL("../index.ts", import.meta.url).pathname,
					...args,
				],
				{
					env: {
						...process.env,
						HOME: home,
						FLYWHEEL_EXEC_ID: envExecId,
						FLYWHEEL_COMM_DB: dbPath,
						FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
						FLYWHEEL_PROJECT_NAME: "flywheel",
						FLYWHEEL_ISSUE_ID: "FLY-1956",
						FLYWHEEL_GATE_MARKER_DIR: "",
						FLYWHEEL_INGEST_TOKEN: "",
						TEAMLEAD_API_TOKEN: "",
					},
					encoding: "utf8",
					timeout: 15_000,
				},
			);
			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(2);
			expect(child.stderr).toContain("STAGE_PENDING");
			expect(existsSync(dbPath)).toBe(false);
			expect(
				existsSync(
					join(
						home,
						".flywheel",
						"state",
						"review-requests",
						"review-request.json",
					),
				),
			).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	},
	20_000,
);
