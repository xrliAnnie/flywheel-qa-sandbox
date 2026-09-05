import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackAction as ChatAction } from "flywheel-edge-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReactionsEngine,
	ProjectAwareApproveHandler,
} from "../ActionExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge",
		projectRoot: "/home/user/geoforge",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeAction(overrides: Partial<ChatAction> = {}): ChatAction {
	return {
		actionId: "flywheel_approve_GEO-95",
		issueId: "GEO-95",
		action: "approve",
		userId: "U123",
		responseUrl: "https://hooks.slack.com/resp",
		messageTs: "123.456",
		executionId: "exec-1",
		...overrides,
	};
}

function makeStore(session?: Session) {
	return {
		getSession: vi.fn().mockReturnValue(session),
		getLatestActionableSession: vi.fn().mockReturnValue(session),
	} as unknown as StateStore;
}

const session: Session = {
	execution_id: "exec-1",
	issue_id: "GEO-95",
	project_name: "geoforge",
	status: "awaiting_review",
};

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.FLYWHEEL_TEST_GH_CALL_LOG;
	delete process.env.FLYWHEEL_TEST_GH_FAIL;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDefaultGhFixture(): {
	root: string;
	callLog: string;
	projects: ProjectEntry[];
} {
	const root = mkdtempSync(join(tmpdir(), "fly2331-action-exec-"));
	tempDirs.push(root);
	const gh = join(root, "gh");
	const callLog = join(root, "gh-calls.log");
	writeFileSync(
		gh,
		[
			"#!/bin/sh",
			'printf "%s|%s\\n" "$PWD" "$*" >> "$FLYWHEEL_TEST_GH_CALL_LOG"',
			'if [ "$FLYWHEEL_TEST_GH_FAIL" = "$2" ]; then',
			'  printf "forced %s failure\\n" "$2" >&2',
			"  exit 7",
			"fi",
			"sleep 0.05",
			'if [ "$2" = "list" ]; then',
			'  printf \'%s\\n\' \'[{"number":42,"url":"https://github.com/pr/42"}]\'',
			"fi",
		].join("\n"),
	);
	chmodSync(gh, 0o755);
	process.env.PATH = `${root}:${originalPath ?? ""}`;
	process.env.FLYWHEEL_TEST_GH_CALL_LOG = callLog;
	return {
		root,
		callLog,
		projects: [
			{
				...projects[0]!,
				projectRoot: root,
				projectRepo: "xrliAnnie/GeoForge3D",
			},
		],
	};
}

describe("ProjectAwareApproveHandler", () => {
	it("looks up session + project and delegates to ApproveHandler", async () => {
		const execFn = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{ number: 42, url: "https://github.com/pr/42" },
				]),
			})
			.mockResolvedValueOnce({ stdout: "" });

		const store = makeStore(session);
		const handler = new ProjectAwareApproveHandler(projects, store, execFn);
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(true);
		expect(result.message).toContain("PR #42 merged");
		expect(execFn).toHaveBeenCalledWith(
			"gh",
			expect.arrayContaining(["pr", "list"]),
			"/home/user/geoforge",
		);
	});

	it("returns error if session not found", async () => {
		const store = makeStore(undefined);
		const handler = new ProjectAwareApproveHandler(projects, store, vi.fn());
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	it("returns error if project not found", async () => {
		const store = makeStore({ ...session, project_name: "unknown-project" });
		const handler = new ProjectAwareApproveHandler(projects, store, vi.fn());
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(false);
		expect(result.message).toContain("No project config");
	});
});

describe("createReactionsEngine", () => {
	it("keeps the event loop live while the default gh list and merge commands run", async () => {
		const fixture = makeDefaultGhFixture();
		const engine = createReactionsEngine(fixture.projects, makeStore(session));
		let intervalTicks = 0;
		const interval = setInterval(() => intervalTicks++, 1);

		const result = await engine.dispatch(
			makeAction({ responseUrl: "invalid-response-url" }),
		);
		clearInterval(interval);

		expect(result.success).toBe(true);
		expect(intervalTicks).toBeGreaterThan(0);
		const childCwd = realpathSync(fixture.root);
		expect(readFileSync(fixture.callLog, "utf8").trim().split("\n")).toEqual([
			`${childCwd}|pr list -R xrliAnnie/GeoForge3D --head flywheel-GEO-95 --json number,url --limit 1`,
			`${childCwd}|pr merge 42 -R xrliAnnie/GeoForge3D --squash --delete-branch`,
		]);
	});

	it("reports a default gh merge failure without asserting the remote state", async () => {
		const fixture = makeDefaultGhFixture();
		process.env.FLYWHEEL_TEST_GH_FAIL = "merge";
		const engine = createReactionsEngine(fixture.projects, makeStore(session));

		const result = await engine.dispatch(
			makeAction({ responseUrl: "invalid-response-url" }),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Approve failed");
		expect(result.message).not.toMatch(/not merged|merge did not happen/i);
	});

	it("returns engine with all handlers", () => {
		const store = makeStore();
		const engine = createReactionsEngine(projects, store);
		expect(engine).toBeDefined();
	});

	it("stub handler for retry returns acknowledgment", async () => {
		const store = makeStore();
		const engine = createReactionsEngine(projects, store);
		const result = await engine.dispatch(
			makeAction({ action: "retry", actionId: "flywheel_retry_GEO-95" }),
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("stub");
	});
});
