import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ExecFileFn, TmuxAdapter } from "flywheel-claude-runner";
import { resetModelConfigCacheForTests } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
} from "../workflow-menu.js";

const EXPECTED_MODEL = "claude-opus-4-6[1m]";
const MUTATION_MODEL = "claude-opus-5[1m]";
const ENV_KEYS = [
	"HOME",
	"PATH",
	"TMUX_TMPDIR",
	"FLYWHEEL_MODELS_CONFIG",
] as const;

type SavedEnv = Record<(typeof ENV_KEYS)[number], string | undefined>;

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index < 0 ? undefined : argv[index + 1];
}

function assertExpectedQaArgv(argv: string[]): void {
	const model = flagValue(argv, "--model");
	if (model === undefined) throw new Error("missing --model");
	if (model !== EXPECTED_MODEL) throw new Error(`wrong --model: ${model}`);
	const effort = flagValue(argv, "--effort");
	if (effort === undefined) throw new Error("missing --effort");
	if (effort !== "high") throw new Error(`wrong --effort: ${effort}`);
}

describe("FLY-1674 real QA Runner argv", () => {
	let root: string;
	let fakeBin: string;
	let modelsPath: string;
	let argvPath: string;
	let socketPath: string;
	let sessionName: string;
	let savedEnv: SavedEnv;

	beforeEach(() => {
		// tmux's Unix-domain socket has a tight path limit on macOS. Use the
		// deliberately short system /tmp alias instead of os.tmpdir()'s long
		// /var/folders/... expansion so this remains a real private server.
		root = mkdtempSync("/tmp/f1674-");
		fakeBin = join(root, "bin");
		const fakeHome = join(root, "home");
		const tmuxTmp = join(root, "tmux");
		modelsPath = join(root, "models.json");
		argvPath = join(root, "claude.argv");
		sessionName = `runner-fly1674-${process.pid}-${Date.now()}`;
		mkdirSync(fakeBin, { recursive: true });
		mkdirSync(fakeHome, { recursive: true });
		mkdirSync(tmuxTmp, { recursive: true });
		socketPath = join(
			tmuxTmp,
			`tmux-${typeof process.getuid === "function" ? process.getuid() : 0}`,
			"default",
		);

		const fakeClaude = join(fakeBin, "claude");
		writeFileSync(
			fakeClaude,
			`#!/bin/sh
if [ "\${1-}" = "--version" ]; then
  printf '%s\\n' 'claude fake 0.0.0'
  exit 0
fi
printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}
`,
		);
		chmodSync(fakeClaude, 0o755);

		savedEnv = Object.fromEntries(
			ENV_KEYS.map((key) => [key, process.env[key]]),
		) as SavedEnv;
		process.env.HOME = fakeHome;
		process.env.PATH = `${fakeBin}:${savedEnv.PATH ?? ""}`;
		process.env.TMUX_TMPDIR = tmuxTmp;
		process.env.FLYWHEEL_MODELS_CONFIG = modelsPath;
	});

	afterEach(() => {
		try {
			execFileSync("tmux", ["-S", socketPath, "kill-server"], {
				stdio: "ignore",
			});
		} catch {
			// An already-dead private server is clean teardown.
		}
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
	});

	async function captureQaArgv(bindingModel: string): Promise<{
		argv: string[];
		compiledModel: string;
		compiledEffort: string;
		openedSocket: string;
	}> {
		writeFileSync(
			modelsPath,
			JSON.stringify({ version: 1, bindings: { opus: bindingModel } }),
		);
		resetModelConfigCacheForTests();
		const code = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "code",
		);
		if (!code) throw new Error("code workflow menu missing");
		const qa = compileWorkflowMenuSeed(code).manifest.nodes.find(
			(node) => node.id === "qa",
		);
		if (!qa?.model || !qa.effort) {
			throw new Error("compiled QA dispatch missing model or effort");
		}

		// This is an address-preserving real executor, not a command mock. The
		// adapter's injected-executor seam still runs the actual tmux and fake
		// claude processes while keeping session creation on our private socket.
		const realProcessExec: ExecFileFn = (command, args, options) => ({
			stdout: execFileSync(command, args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: options?.timeoutMs,
				env: options?.env ? { ...process.env, ...options.env } : process.env,
			}),
		});
		const adapter = new TmuxAdapter(sessionName, realProcessExec, 10, 5_000);
		let openedSocket = "";
		await adapter.execute({
			executionId: `fly1674-${Date.now()}`,
			issueId: "FLY-1674",
			prompt: "capture final QA argv",
			cwd: root,
			model: qa.model,
			effort: qa.effort,
			onTmuxWindowOpened: (generation) => {
				openedSocket = generation.socketPath;
			},
			timeoutMs: 5_000,
		});

		return {
			argv: readFileSync(argvPath, "utf8").trimEnd().split("\n"),
			compiledModel: qa.model,
			compiledEffort: qa.effort,
			openedSocket,
		};
	}

	it("carries the 4.6-bound compiled QA node into a real claude process argv", async () => {
		const proof = await captureQaArgv(EXPECTED_MODEL);

		expect(proof.compiledModel).toBe(EXPECTED_MODEL);
		expect(proof.compiledEffort).toBe("high");
		expect(realpathSync(proof.openedSocket)).toBe(realpathSync(socketPath));
		expect(() => assertExpectedQaArgv(proof.argv)).not.toThrow();
		expect(proof.argv).toContain("--model");
		expect(proof.argv).toContain(EXPECTED_MODEL);
		expect(proof.argv).toContain("--effort");
		expect(proof.argv).toContain("high");
	}, 15_000);

	it("makes the same proof fail loudly for a wrong binding and a missing model flag", async () => {
		const mutation = await captureQaArgv(MUTATION_MODEL);

		expect(mutation.compiledModel).toBe(MUTATION_MODEL);
		expect(() => assertExpectedQaArgv(mutation.argv)).toThrow(
			`wrong --model: ${MUTATION_MODEL}`,
		);
		const modelIndex = mutation.argv.indexOf("--model");
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		const missingModel = mutation.argv.filter(
			(_argument, index) => index !== modelIndex && index !== modelIndex + 1,
		);
		expect(() => assertExpectedQaArgv(missingModel)).toThrow("missing --model");
	}, 15_000);
});
