import { type ChildProcess, fork } from "node:child_process";
import {
	appendFile,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { CODEX_QUOTA_FAILURE_REASON } from "flywheel-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createCodexQuotaOutboxDelivery } from "../../codex-quota/outbox.js";
import { codexQuotaIdentityReader } from "../../codex-quota/probe.js";
import { createCodexQuotaRunRecovery } from "../../codex-quota/run-recovery.js";
import { CodexQuotaRuntime } from "../../codex-quota/runtime.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import { createCodexQuotaRouter } from "../codex-quota-route.js";
import { createEventRouter } from "../event-route.js";
import type { IStartDispatcher } from "../retry-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import { createRunsRouter } from "../runs-route.js";

const host = vi.hoisted(() => ({ pids: new Map<string, number>() }));
const live = async (id: string): Promise<"alive" | "dead" | "unknown"> => {
	const pid = host.pids.get(id);
	if (!pid) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH"
			? "dead"
			: "unknown";
	}
};
vi.mock("@linear/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@linear/sdk")>();
	vi.spyOn(actual.LinearClient.prototype, "issue").mockImplementation((async (
		id: string,
	) => ({
		id,
		title: "Synthetic quota bench",
		identifier: id,
		url: "https://example.test/fixture",
		labels: async () => ({ nodes: [{ name: "Product" }] }),
	})) as never);
	return actual;
});
vi.mock("../generalized-launch-recovery.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../generalized-launch-recovery.js")>();
	return {
		...actual,
		waitForGeneralizedLaunchDelivery: (
			store: Parameters<typeof actual.waitForGeneralizedLaunchDelivery>[0],
			id: string,
		) => actual.waitForGeneralizedLaunchDelivery(store, id, { timeoutMs: 0 }),
	};
});
vi.mock("../run-quiescence.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../run-quiescence.js")>();
	return {
		...actual,
		collectRunQuiescenceEvidence: (store: StateStore, id: string) =>
			actual.collectRunQuiescenceEvidence(store, id, async (exec) => {
				const pid = host.pids.get(exec);
				if (!pid) return "unknown";
				try {
					process.kill(pid, 0);
					return "alive";
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "ESRCH"
						? "dead"
						: "unknown";
				}
			}),
	};
});
const fixtureDir = fileURLToPath(
	new URL("../../../../../scripts/fixtures/codex-quota/", import.meta.url),
);
const registry = {
	version: 1 as const,
	primary: "personal" as const,
	profiles: ["school", "personal", "business"].map((name) => ({
		name: name as "school" | "personal" | "business",
		email: `${name}@example.test`,
		role:
			name === "personal" ? ("primary" as const) : ("manual_backup" as const),
	})),
};
const summaries: Record<string, unknown>[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	host.pids.clear();
	vi.unstubAllEnvs();
});
afterAll(async () => {
	if (process.env.FLY2465_BENCH_OUTPUT)
		await writeFile(
			process.env.FLY2465_BENCH_OUTPUT,
			JSON.stringify(
				{
					schemaVersion: 1,
					provider: "synthetic-no-network",
					scenarios: summaries,
				},
				null,
				2,
			),
		);
});
async function kill(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const done = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	child.kill("SIGKILL");
	await done;
}
async function worker(authPath: string, id: string) {
	const child = fork(join(fixtureDir, "worker.cjs"), [authPath], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { PATH: process.env.PATH },
	});
	await new Promise<void>((resolve, reject) => {
		child.once("message", () => resolve());
		child.once("error", reject);
	});
	host.pids.set(id, child.pid!);
	cleanup.push(() => kill(child));
	return child;
}
async function work(child: ChildProcess, command = "work") {
	const response = new Promise<unknown>((resolve) =>
		child.once("message", resolve),
	);
	child.send(command);
	return response;
}
async function fixture(
	scenario: "success" | "exhausted" | "probe_failed" | "queued",
) {
	await import("@linear/sdk");
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "fly2465-http-bench-")),
	);
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	for (const name of [
		"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
		"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
		"FLYWHEEL_WORKFLOW_CLAIMS_READ",
		"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
	])
		vi.stubEnv(name, "1");
	vi.stubEnv("HOME", root);
	vi.stubEnv("FLYWHEEL_STATE_DIR", join(root, "state"));
	vi.stubEnv("FLYWHEEL_COMM_ROOT", join(root, "comm"));
	vi.stubEnv("LINEAR_API_KEY", "synthetic");
	const canonicalHome = join(root, "canonical"),
		profilesRoot = join(root, "profiles"),
		projectRoot = join(root, "project");
	await mkdir(canonicalHome);
	await mkdir(profilesRoot);
	await mkdir(join(projectRoot, "agents"), { recursive: true });
	await writeFile(
		join(projectRoot, "agents", "generic.md"),
		"Synthetic fixture worker only.",
	);
	const journalPath = join(root, "cli.jsonl"),
		authorityPath = join(root, "authority.json");
	await writeFile(journalPath, "");
	await writeFile(
		authorityPath,
		JSON.stringify({
			scenario,
			tokens: {
				school: "school:0",
				personal: "personal:0",
				business: "business:0",
			},
		}),
	);
	const auth = (profile: string) =>
		JSON.stringify({
			tokens: {
				id_token: `x.${Buffer.from(JSON.stringify({ email: `${profile}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: profile } })).toString("base64url")}.x`,
				refresh_token: `${profile}:0`,
			},
			fixture: { profile, journalPath, authorityPath },
		});
	for (const p of registry.profiles) {
		await mkdir(join(profilesRoot, p.name));
		await writeFile(join(profilesRoot, p.name, "auth.json"), auth(p.name), {
			mode: 0o600,
		});
	}
	await writeFile(join(canonicalHome, "auth.json"), auth("business"), {
		mode: 0o600,
	});
	const binary = join(root, "fixture-codex");
	await copyFile(join(fixtureDir, "protocol-cli.cjs"), binary);
	await chmod(binary, 0o700);
	const store = await StateStore.create(join(root, "teamlead.db"));
	cleanup.push(async () => store.close());
	const projects: ProjectEntry[] = [
		{
			projectName: "QuotaBench",
			projectRoot,
			leads: [
				{
					agentId: "bench-lead",
					forumChannel: "fixture-forum",
					chatChannel: "fixture-chat",
					match: { labels: ["Product"] },
				},
			],
		},
	];
	let runtime: CodexQuotaRuntime;
	let rootKey = "";
	let base = "";
	const homes: string[] = [];
	const spawned = new Map<string, ChildProcess>();
	const commits: Array<() => unknown> = [];
	const requests: Array<{ path: string; status: number }> = [];
	const dispatcher: IStartDispatcher = {
		getInflightCount: () => 0,
		start: async (req) => {
			const g = req.generalizedExecution;
			if (!g) throw new Error("bench requires generalized dispatch");
			store.upsertSession({
				execution_id: g.executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
				adapter_type: "codex-tmux",
				runner_model: "gpt-5.6-sol",
				session_role: req.sessionRole,
			});
			const home = join(root, `runner-${g.executionId}`);
			await mkdir(home);
			await symlink(join(canonicalHome, "auth.json"), join(home, "auth.json"));
			homes.push(home);
			await runtime.beforeCodexDaemonStart(home, g.executionId);
			const child = await worker(join(home, "auth.json"), g.executionId);
			spawned.set(g.executionId, child);
			if (scenario === "queued") commits.push(() => g.commitWorkflowLaunch?.());
			else expect(g.commitWorkflowLaunch?.()).toMatchObject({ ok: true });
			return { executionId: g.executionId, issueId: req.issueId };
		},
	};
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		res.on("finish", () =>
			requests.push({ path: req.originalUrl, status: res.statusCode }),
		);
		next();
	});
	app.use(
		"/api/events",
		(req, res, next) => {
			if (req.get("authorization") !== "Bearer fixture-ingest") {
				res.sendStatus(401);
				return;
			}
			next();
		},
		createEventRouter(store, projects, {
			host: "127.0.0.1",
			port: 0,
			dbPath: join(root, "teamlead.db"),
			ingestToken: "fixture-ingest",
			notificationChannel: "fixture",
			defaultLeadAgentId: "bench-lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
		}),
	);
	app.use(
		"/api/codex/quota",
		createCodexQuotaRouter({
			store,
			ingestToken: "fixture-ingest",
			credential: () => runtime.credential(),
		}),
	);
	app.use(
		"/api/runs",
		createRunsRouter(
			dispatcher,
			store,
			projects,
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			{
				masterToken: "fixture-master",
				codexQuotaRootKey: () => rootKey,
				verifyCodexQuotaRecovery: (id) => recovery.canRecover(id),
			},
		),
	);
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const recovery = createCodexQuotaRunRecovery({
		store,
		canonicalHome,
		identify: codexQuotaIdentityReader(registry),
		bridgeUrl: base,
		apiToken: "fixture-master",
		verifyLiveness: live,
		readiness: () => runtime.readiness(),
	});
	const makeRuntime = () =>
		new CodexQuotaRuntime({
			store,
			canonicalHome,
			profilesRoot,
			stateRoot: join(root, "state"),
			rawBinary: binary,
			registry,
			model: "gpt-5.6-sol",
			limitId: "codex",
			collectHomes: async () => ({
				complete: true,
				homes: await Promise.all(
					homes.map(async (home) => ({
						home,
						ownership: "managed" as const,
						activity:
							(await live(basename(home).replace(/^runner-/, ""))) === "dead"
								? ("drained" as const)
								: ("active" as const),
					})),
				),
			}),
			recover: recovery.recover,
		});
	runtime = makeRuntime();
	cleanup.push(() => runtime.stop());
	rootKey = (await runtime.credential()).rootKey;
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "fixture", revision: 1 },
		canonicalRoot: projectRoot,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "gate", type: "gate" },
			],
			edges: [
				{ id: "done", from: "execute", to: "gate", condition: "node_done" },
			],
			loops: [],
			terminal_gate: { node: "gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	const original = [];
	for (let i = 0; i < 6; i++) {
		const runId = `old-run-${i}`,
			executionId = `old-exec-${i}`,
			issueId = `FLY-BENCH-${i}`;
		store.createWorkflowRun({
			runId,
			issueId,
			projectName: "QuotaBench",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: false,
		});
		const now = Date.now();
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId,
				nodeId: "execute",
				executionId,
				attempt: 1,
				now: new Date(now).toISOString(),
				expiresAt: new Date(now + 3600000).toISOString(),
				absoluteDeadlineAt: new Date(now + 86400000).toISOString(),
				env: process.env,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: executionId,
			issue_id: issueId,
			project_name: "QuotaBench",
			status: "running",
			adapter_type: "codex-tmux",
			runner_model: "gpt-5.6-sol",
		});
		const home = join(root, executionId);
		await mkdir(home);
		await symlink(join(canonicalHome, "auth.json"), join(home, "auth.json"));
		homes.push(home);
		const binding = await runtime.beforeCodexDaemonStart(home, executionId);
		const child = await worker(join(home, "auth.json"), executionId);
		await kill(child);
		original.push({ runId, executionId, issueId, binding });
	}
	const post = (path: string, body: unknown, token = "fixture-ingest") =>
		fetch(base + path, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	const intake = async () => {
		for (const item of original) {
			const signal = {
				version: 1,
				vendor: "codex",
				source: "goal_ended",
				sourceEventId: `ended-${item.executionId}`,
				bindingId: item.binding.bindingId,
				evidence: "usageLimited",
				observedAt: new Date().toISOString(),
			};
			const event = {
				event_id: signal.sourceEventId,
				execution_id: item.executionId,
				issue_id: item.issueId,
				project_name: "QuotaBench",
				event_type: "session_failed",
				source: "fixture",
				payload: {
					failure: {
						failureKind: "goal_usage_limited",
						failureReason: CODEX_QUOTA_FAILURE_REASON,
						quotaSignal: signal,
					},
				},
			};
			const response = await post("/api/events", event);
			expect(response.status, await response.clone().text()).toBe(200);
			expect((await post("/api/events", event)).status).toBe(200);
		}
	};
	const sink = join(root, "messages.jsonl");
	await writeFile(sink, "");
	const deliver = createCodexQuotaOutboxDelivery({
		store,
		founderUserId: "123456789012345678",
		send: async (payload) => {
			await appendFile(sink, `${JSON.stringify(payload)}\n`);
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"queued_durable",
				new Date().toISOString(),
			);
		},
	});
	const incidentId = `codex:${rootKey}:1`;
	return {
		root,
		store,
		get runtime() {
			return runtime;
		},
		reconstructRuntime: async () => {
			await runtime.stop();
			runtime = makeRuntime();
		},
		profilesRoot,
		post,
		intake,
		incidentId,
		requests,
		original,
		spawned,
		commits,
		deliver,
		sink,
		journalPath,
		canonicalHome,
	};
}

it.each(["success", "queued", "crash_reconstruct"] as const)(
	"HTTP casualty intake -> runtime probe -> six real isolated route recoveries (%s)",
	async (scenario) => {
		const f = await fixture(
			scenario === "crash_reconstruct" ? "success" : scenario,
		);
		const started = Date.now();
		await f.intake();
		expect(f.store.codexQuota.listIncidents()).toHaveLength(1);
		expect(f.store.codexQuota.listTargets(f.incidentId)).toHaveLength(6);
		if (scenario === "crash_reconstruct") {
			await f.runtime.stop();
			const owner = fork(
				join(fixtureDir, "crash-refresh.cjs"),
				[
					join(
						fixtureDir,
						"../../../packages/claude-runner/bin/codex-account-install.mjs",
					),
					f.profilesRoot,
				],
				{
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					env: { PATH: process.env.PATH },
				},
			);
			cleanup.push(() => kill(owner));
			await new Promise<void>((resolve, reject) => {
				owner.once("message", () => resolve());
				owner.once("error", reject);
				owner.once("exit", () =>
					reject(new Error("crash refresh owner exited before rotation")),
				);
			});
			await kill(owner);
			await f.reconstructRuntime();
		}
		await f.runtime.tick();
		if (scenario === "queued") {
			expect(
				f.store.codexQuota.listTargets(f.incidentId).map((row) => row.state),
			).toEqual(Array(6).fill("queued"));
			for (const commit of f.commits)
				expect(commit()).toMatchObject({ ok: true });
			await f.runtime.tick();
		}
		const targets = f.store.codexQuota.listTargets(f.incidentId);
		expect(
			targets.map((row) => row.state),
			JSON.stringify({
				incident: f.store.codexQuota.getIncident(f.incidentId),
				requests: f.requests,
				targets: await Promise.all(
					targets.map(async (row) => ({
						...row,
						session:
							typeof row.new_execution_id === "string"
								? f.store.getSession(row.new_execution_id)
								: null,
						bindings:
							typeof row.new_execution_id === "string"
								? f.store.codexQuota.getRunnerBindings(row.new_execution_id)
								: [],
						live:
							typeof row.new_execution_id === "string"
								? await live(row.new_execution_id)
								: null,
					})),
				),
			}),
		).toEqual(Array(6).fill("recovered"));
		expect(f.spawned.size).toBe(6);
		expect(
			f.requests.filter((r) => r.path.endsWith("/terminate")),
		).toHaveLength(6);
		expect(Date.now() - started).toBeLessThan(600000);
		for (const child of f.spawned.values())
			expect(await work(child, "refresh")).toMatchObject({
				ok: true,
				profile: "school",
			});
		for (const child of f.spawned.values())
			expect(await work(child)).toMatchObject({ ok: true, profile: "school" });
		await f.deliver();
		await f.deliver();
		const messages = (await readFile(f.sink, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(messages.filter((m) => m.eventType === "usage_limit")).toHaveLength(
			1,
		);
		expect(messages.filter((m) => m.mentionUserId)).toHaveLength(0);
		const cli = (await readFile(f.journalPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(cli.filter((r) => r.kind === "probe_ok")).toHaveLength(1);
		summaries.push({
			scenario,
			recovered: 6,
			usageLimitMessages: 1,
			founderMessages: 0,
			probeOk: 1,
			elapsedMs: Date.now() - started,
			provider: "synthetic",
			actualRunRoutes: true,
			refreshBoundaryWorkers: 6,
		});
	},
	30000,
);
it.each(["exhausted", "probe_failed"] as const)(
	"HTTP quota failure %s has no blind replacement or restart",
	async (scenario) => {
		const f = await fixture(scenario);
		const before = await readFile(join(f.canonicalHome, "auth.json"), "utf8");
		await f.intake();
		await f.runtime.tick();
		await f.runtime.tick();
		expect(
			f.store.codexQuota.getIncident(f.incidentId)?.state,
			JSON.stringify(f.store.codexQuota.getIncident(f.incidentId)),
		).toBe(scenario === "exhausted" ? "pool_exhausted" : "probe_failed");
		expect(f.spawned.size).toBe(0);
		expect(
			f.requests.filter((r) => r.path.startsWith("/api/runs/")),
		).toHaveLength(0);
		expect(await readFile(join(f.canonicalHome, "auth.json"), "utf8")).toBe(
			before,
		);
		for (const item of f.original) {
			expect(
				f.store.rollbackDeadWorkflowNodeExecution({
					runId: item.runId,
					nodeId: "execute",
					attempt: 1,
					deadExecutionId: item.executionId,
					newExecutionId: `blind-${item.executionId}`,
					reason: "quota bench dead",
					livenessEvidence: {
						liveness: "dead",
						observedAt: new Date().toISOString(),
					},
				}),
			).toEqual({ ok: false, reason: "codex_quota_paused" });
			expect(f.store.getSession(`blind-${item.executionId}`)).toBeUndefined();
		}
		await f.deliver();
		await f.deliver();
		const messages = (await readFile(f.sink, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(messages.filter((m) => m.eventType === "usage_limit")).toHaveLength(
			1,
		);
		expect(messages.filter((m) => m.mentionUserId)).toHaveLength(
			scenario === "exhausted" ? 1 : 0,
		);
		const cli = (await readFile(f.journalPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(cli.filter((row) => row.kind === "probe")).toHaveLength(
			scenario === "exhausted" ? 0 : 1,
		);
		summaries.push({
			scenario,
			recovered: 0,
			usageLimitMessages: 1,
			founderMessages: scenario === "exhausted" ? 1 : 0,
			blindReplacements: 0,
			probeAttempts: scenario === "exhausted" ? 0 : 1,
			actualRunRoutes: true,
		});
	},
	30000,
);
it("HTTP review generic429 is rejected without an incident, probe, or restart", async () => {
	const f = await fixture("success");
	const credential = await f.runtime.credential();
	const item = f.original[0];
	const bound = await f.post("/api/codex/quota/bind", {
		executionId: item.executionId,
		projectName: "QuotaBench",
		invocationId: "generic429",
		purpose: "review",
		model: "gpt-5.6-sol",
		authDigest: credential.authDigest,
	});
	expect(bound.status).toBe(200);
	const { binding } = await bound.json();
	const result = await f.post("/api/codex/quota/observe", {
		executionId: item.executionId,
		projectName: "QuotaBench",
		signal: {
			version: 1,
			vendor: "codex",
			source: "review_exec",
			sourceEventId: "generic429",
			bindingId: binding.bindingId,
			evidence: "rateLimitExceeded",
			observedAt: new Date().toISOString(),
		},
	});
	expect(result.status).toBe(400);
	await f.runtime.tick();
	expect(f.store.codexQuota.listIncidents()).toHaveLength(0);
	expect(f.spawned.size).toBe(0);
	expect(await readFile(f.journalPath, "utf8")).toBe("");
	summaries.push({
		scenario: "generic429",
		incidents: 0,
		probeAttempts: 0,
		recovered: 0,
	});
}, 30000);
