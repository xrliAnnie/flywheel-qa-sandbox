import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	type CodexAccountRegistry,
	identifyCodexAuth,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";

import {
	acquireCodexAccountLease,
	type CodexAccountLease,
	codexInstallAccountKey,
	markCodexCandidateProcess,
	registerCodexCandidateWorkspace,
	resolveCodexCandidateRecovery,
} from "flywheel-claude-runner/bin/codex-account-install.mjs";

export interface CandidateIdentity {
	profile: string;
	accountKey: string;
}
export function codexQuotaIdentityReader(
	registry: CodexAccountRegistry,
): (auth: string) => CandidateIdentity {
	return (auth) => {
		const identity = identifyCodexAuth(auth, registry);
		return {
			profile: identity.profile,
			accountKey: codexInstallAccountKey(identity),
		};
	};
}
export interface CandidateWorkspace {
	home: string;
	cwd: string;
	authPath: string;
	originalAuthDigest: string;
	accountLease: CodexAccountLease;
	/** Call only after final credentials have been durably retained by installer/profile owner. */
	discardAfterCredentialPersistence(persistedAuthPath: string): Promise<void>;
}
const queues = new Map<string, Promise<void>>();
export class CodexCandidateWorkspace {
	constructor(
		private readonly root: string,
		private readonly options: { profilesRoot: string },
	) {
		if (!options || !isAbsolute(options.profilesRoot))
			throw new Error("profiles_root_must_be_absolute");
		if (!isAbsolute(root)) throw new Error("candidate_root_must_be_absolute");
	}
	async run<T>(
		accountKey: string,
		initialAuth: string | (() => Promise<string>),
		callback: (workspace: CandidateWorkspace) => Promise<T>,
	): Promise<T> {
		const lockKey = createHash("sha256").update(accountKey).digest("hex");
		const previous = queues.get(lockKey) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		queues.set(lockKey, current);
		await previous;
		let accountLease: CodexAccountLease | undefined;
		try {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			accountLease = acquireCodexAccountLease(
				this.options.profilesRoot,
				accountKey,
			);
			if (accountLease.orphanRecovery)
				throw new Error("codex_candidate_recovery_required");
			const auth =
				typeof initialAuth === "function" ? await initialAuth() : initialAuth;
			const home = await mkdtemp(join(this.root, `${lockKey}-`));
			await chmod(home, 0o700);
			const cwd = join(home, "empty");
			await mkdir(cwd, { mode: 0o700 });
			const authPath = join(home, "auth.json");
			await writeFile(authPath, auth, { mode: 0o600 });
			await writeFile(
				join(home, "config.toml"),
				'cli_auth_credentials_store = "file"\n',
				{ mode: 0o600 },
			);
			registerCodexCandidateWorkspace(accountLease, {
				authPath,
				originalAuthDigest: createHash("sha256").update(auth).digest("hex"),
			});
			return await callback({
				home,
				cwd,
				authPath,
				accountLease,
				originalAuthDigest: createHash("sha256").update(auth).digest("hex"),
				discardAfterCredentialPersistence: async (persistedAuthPath) => {
					resolveCodexCandidateRecovery(accountLease!, persistedAuthPath);
					await rm(home, { recursive: true, force: true });
				},
			});
		} finally {
			// Workspaces deliberately survive exceptions: refreshed credentials may be the only live chain.
			try {
				accountLease?.release();
			} finally {
				release();
				if (queues.get(lockKey) === current) queues.delete(lockKey);
			}
		}
	}
}
export function sanitizedCodexEnvironment(
	home: string,
	ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		CODEX_HOME: home,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
	};
	for (const key of [
		"PATH",
		"LANG",
		"LC_ALL",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	])
		if (ambient[key]) env[key] = ambient[key];
	return env;
}
export interface IsolatedCodexProcessOptions {
	binary: string;
	workspace: CandidateWorkspace;
	args: string[];
	timeoutMs: number;
	signal?: AbortSignal;
	onLine?: (line: string, child: ChildProcessWithoutNullStreams) => void;
	onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}
export interface IsolatedCodexProcessResult {
	exitCode: number | null;
	stdout: string;
	failed: boolean;
}
/** Uses a private process group and waits for close after TERM/KILL. Output is bounded and never logged. */
export async function runIsolatedCodex(
	options: IsolatedCodexProcessOptions,
): Promise<IsolatedCodexProcessResult> {
	if (!isAbsolute(options.binary))
		throw new Error("raw_codex_binary_must_be_absolute");
	if (options.signal?.aborted)
		return { exitCode: null, stdout: "", failed: true };
	return new Promise((resolve) => {
		markCodexCandidateProcess(options.workspace.accountLease, {
			state: "starting",
		});
		const child = spawn(options.binary, options.args, {
			cwd: options.workspace.cwd,
			env: sanitizedCodexEnvironment(options.workspace.home),
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "",
			pending = "",
			failed = false,
			closed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (child.pid)
				markCodexCandidateProcess(options.workspace.accountLease, {
					state: "running",
					pid: child.pid,
				});
		} catch {
			failed = true;
		}
		const kill = (signal: NodeJS.Signals) => {
			if (child.pid) {
				try {
					process.kill(-child.pid, signal);
				} catch {
					/* process already exited */
				}
			}
		};
		const stop = () => {
			failed = true;
			kill("SIGTERM");
			if (!killTimer) killTimer = setTimeout(() => kill("SIGKILL"), 200);
		};
		const timer = setTimeout(stop, options.timeoutMs);
		options.signal?.addEventListener("abort", stop, { once: true });
		const finish = (exitCode: number | null) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", stop);
			kill("SIGKILL");
			try {
				markCodexCandidateProcess(options.workspace.accountLease, {
					state: "stopped",
					pid: child.pid,
				});
			} catch {
				failed = true;
			}
			resolve({ exitCode, stdout: output, failed });
		};
		child.on("error", () => {
			failed = true;
			finish(null);
		});
		child.on("close", finish);
		child.stderr.on("data", () => {
			/* never retain provider error text, which can contain credentials */
		});
		child.stdin.on("error", () => stop());
		child.stdout.on("data", (data: Buffer) => {
			if (failed) return;
			if (Buffer.byteLength(output) + data.length > 262144) {
				stop();
				return;
			}
			output += data.toString("utf8");
			pending += data.toString("utf8");
			if (
				Buffer.byteLength(output) > 262144 ||
				Buffer.byteLength(pending) > 65536
			) {
				stop();
				return;
			}
			while (pending.includes("\n")) {
				const newline = pending.indexOf("\n");
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					options.onLine?.(line, child);
				} catch {
					stop();
				}
			}
		});
		if (failed) stop();
		try {
			options.onSpawn?.(child);
		} catch {
			stop();
		}
	});
}
export interface CodexProbeOptions {
	workspace: CandidateWorkspace;
	binary: string;
	model: string;
	profile: string;
	accountKey: string;
	identify: (auth: string) => CandidateIdentity;
	signal?: AbortSignal;
}
export interface CodexProbeResult {
	ok: boolean;
	reason: "ok" | "probe_failed" | "identity_mismatch";
	finalAuthPath: string;
	finalAuthDigest?: string;
}
export async function probeCodexCandidate(
	options: CodexProbeOptions,
): Promise<CodexProbeResult> {
	const failure = (reason: CodexProbeResult["reason"]): CodexProbeResult => ({
		ok: false,
		reason,
		finalAuthPath: options.workspace.authPath,
	});
	const matches = (raw: string) => {
		const identity = options.identify(raw);
		return (
			identity.profile === options.profile &&
			identity.accountKey === options.accountKey
		);
	};
	try {
		if (!matches(await readFile(options.workspace.authPath, "utf8")))
			return failure("identity_mismatch");
		const resultPath = join(options.workspace.home, "probe-result");
		await writeFile(resultPath, "", { mode: 0o600 });
		const result = await runIsolatedCodex({
			binary: options.binary,
			workspace: options.workspace,
			signal: options.signal,
			timeoutMs: 60_000,
			args: [
				"exec",
				"--json",
				"--sandbox",
				"read-only",
				"--skip-git-repo-check",
				"--output-last-message",
				resultPath,
				"-c",
				'cli_auth_credentials_store="file"',
				"-m",
				options.model,
				"Reply exactly ok. Do not call tools.",
			],
		});
		const finalAuth = await readFile(options.workspace.authPath, "utf8");
		await chmod(options.workspace.authPath, 0o600);
		if (!matches(finalAuth)) return failure("identity_mismatch");
		let unsafe = false;
		for (const line of result.stdout.split("\n").filter((l) => l.trim())) {
			try {
				const event = JSON.parse(line);
				const type = event?.item?.type;
				if (
					event.error ||
					![
						"thread.started",
						"turn.started",
						"turn.completed",
						"item.started",
						"item.updated",
						"item.completed",
					].includes(event.type) ||
					(type && !["agent_message", "reasoning"].includes(type))
				)
					unsafe = true;
			} catch {
				unsafe = true;
			}
		}
		if (
			result.failed ||
			result.exitCode !== 0 ||
			unsafe ||
			(await readFile(resultPath, "utf8")).trim() !== "ok"
		)
			return failure("probe_failed");
		return {
			ok: true,
			reason: "ok",
			finalAuthPath: options.workspace.authPath,
			finalAuthDigest: createHash("sha256").update(finalAuth).digest("hex"),
		};
	} catch {
		return failure("probe_failed");
	}
}
