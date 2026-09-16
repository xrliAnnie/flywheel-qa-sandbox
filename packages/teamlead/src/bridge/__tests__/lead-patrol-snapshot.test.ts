import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
	executeLeadPatrolSnapshot,
	PATROL_HELPER_SOURCES,
} from "../lead-patrol-snapshot.js";

it("runs the actual fixed helper in isolated paths and verifies its report without database creation", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-exec-")));
	const deploymentRoot = realpathSync(resolve("../.."));
	const stateDir = join(root, "state"),
		activationRoot = join(root, "control");
	mkdirSync(stateDir, { mode: 0o700 });
	mkdirSync(activationRoot, { mode: 0o700 });
	const projectsPath = join(root, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "demo",
				projectRepo: "owner/repo",
				leads: [{ agentId: "eng" }],
			},
		]),
	);
	const helperPins = Object.fromEntries(
		PATROL_HELPER_SOURCES.map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(join(deploymentRoot, path)))
				.digest("hex"),
		]),
	);
	try {
		const options = {
			deploymentRoot,
			helperPins,
			nodePath: realpathSync(process.execPath),
			stateDir,
			activationRoot,
			projectsPath,
			stateDbPath: join(root, "absent-state.db"),
			commDbPath: join(root, "demo", "comm.db"),
			projectName: "demo",
			leadId: "eng",
			tickId: "1",
			githubFacts: {
				projectName: "demo",
				leadId: "eng",
				pulls: [],
				runs: { workflow_runs: [] },
			},
			secrets: ["SECRET_CANARY"],
			signal: new AbortController().signal,
			assertCurrent: async () => {},
		};
		const result = await executeLeadPatrolSnapshot(options);
		expect(result.text).toContain(
			"# Lead Patrol Snapshot\npatrol_schema=2\nproject: demo\nlead: eng",
		);
		expect(result.text).toContain("PR none");
		expect(
			result.path.startsWith(`${join(stateDir, "patrol-reports", "eng")}/`),
		).toBe(true);
		expect(readFileSync(result.path, "utf8")).toBe(result.text);
		expect(result.steps).toHaveLength(6);
		expect(result.steps.every((step) => step.status !== "healthy")).toBe(true);
		expect(existsSync(options.stateDbPath)).toBe(false);
		expect(existsSync(options.commDbPath)).toBe(false);
		await expect(
			executeLeadPatrolSnapshot({ ...options, tmuxSocketPath: projectsPath }),
		).rejects.toThrow();
		await expect(
			executeLeadPatrolSnapshot({
				...options,
				nodePath: join(dirname(options.nodePath), "not-node"),
			}),
		).rejects.toThrow();

		await expect(
			executeLeadPatrolSnapshot({
				...options,
				helperPins: {
					...helperPins,
					[PATROL_HELPER_SOURCES[0]]: "0".repeat(64),
				},
			}),
		).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

it("cancels a running helper and removes scratch after credentials and shell hooks are washed", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-cancel-")));
	const deploymentRoot = join(root, "deployment"),
		stateDir = join(root, "state"),
		activationRoot = join(root, "control");
	for (const path of [deploymentRoot, stateDir, activationRoot])
		mkdirSync(path, { mode: 0o700 });
	for (const name of PATROL_HELPER_SOURCES) {
		const path = join(deploymentRoot, name);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "# pinned test dependency\n");
	}
	writeFileSync(
		join(deploymentRoot, PATROL_HELPER_SOURCES[0]),
		`#!/bin/bash
for key in GH_TOKEN FLYWHEEL_API_TOKEN NODE_OPTIONS BASH_ENV; do
 [ -z "\${!key+x}" ] || exit 70
done
printf '%s\\n' "$@" > "$FLYWHEEL_STATE_DIR/child.args"
echo "$$" > "$FLYWHEEL_STATE_DIR/child.pid"
while :; do /bin/sleep 1; done
`,
	);
	const hook = join(root, "poison.sh");
	writeFileSync(hook, "exit 73\n");
	vi.stubEnv("BASH_ENV", hook);
	vi.stubEnv("GH_TOKEN", "CREDENTIAL_CANARY");
	vi.stubEnv("FLYWHEEL_API_TOKEN", "CREDENTIAL_CANARY");
	vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
	const controller = new AbortController();
	const helperPins = Object.fromEntries(
		PATROL_HELPER_SOURCES.map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(join(deploymentRoot, path)))
				.digest("hex"),
		]),
	);
	const socketPath = join(root, "owned socket");
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	chmodSync(socketPath, 0o600);
	const work = executeLeadPatrolSnapshot({
		tmuxSocketPath: socketPath,
		deploymentRoot,
		helperPins,
		nodePath: realpathSync(process.execPath),
		stateDir,
		activationRoot,
		projectsPath: join(root, "projects.json"),
		stateDbPath: join(root, "absent.db"),
		commDbPath: join(root, "demo/comm.db"),
		projectName: "demo",
		leadId: "eng",
		tickId: "1",
		githubFacts: {},
		secrets: ["CREDENTIAL_CANARY"],
		signal: controller.signal,
		assertCurrent: async () => {},
	}).then(
		() => "succeeded",
		() => "rejected",
	);
	try {
		const pidPath = join(stateDir, "child.pid");
		for (let i = 0; i < 250 && !existsSync(pidPath); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(pidPath)).toBe(true);
		expect(readFileSync(join(stateDir, "child.args"), "utf8")).toContain(
			`--tmux-socket\n${socketPath}\n`,
		);
		const pid = Number(readFileSync(pidPath, "utf8"));
		controller.abort();
		expect(await work).toBe("rejected");
		expect(() => process.kill(pid, 0)).toThrow();
		expect(readdirSync(activationRoot)).toEqual([]);
	} finally {
		controller.abort();
		await work;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
}, 10000);
