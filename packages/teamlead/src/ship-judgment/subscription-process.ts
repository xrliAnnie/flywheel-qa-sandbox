import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscriptionAuthentication } from "./subscription-auth.js";
import { subscriptionConfiguration } from "./subscription-config.js";

export type SubscriptionProcessResult =
	| { ok: true; stdout: string; spawned: true }
	| { ok: false; reason: string; spawned: boolean };
export interface SubscriptionProcessOptions {
	bin: string;
	input: string;
	model: string;
	effort: string;
	systemPrompt: string;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Tests may shorten these limits; callers cannot enlarge them. */
	timeoutMs?: number;
	killGraceMs?: number;
}

/** One launch, no retry. Resolution waits for close, including after TERM/KILL. */
export async function runSubscriptionProcess(
	options: SubscriptionProcessOptions,
): Promise<SubscriptionProcessResult> {
	if (Buffer.byteLength(options.input) > 98_304)
		return { ok: false, reason: "input_budget_exceeded", spawned: false };
	if (options.signal?.aborted)
		return { ok: false, reason: "model_aborted", spawned: false };
	const ambient = options.env ?? process.env;
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "USER", "LOGNAME", "TMPDIR"])
		if (ambient[key] !== undefined) env[key] = ambient[key];
	const configuration = subscriptionConfiguration(
		options.model,
		options.effort,
	);
	Object.assign(env, configuration.thinkingEnv);
	let root: string;
	let cwd: string;
	try {
		root = await mkdtemp(join(tmpdir(), "ship-judgment-model-"));
		cwd = join(root, "work");
	} catch {
		return { ok: false, reason: "model_workspace_failed", spawned: false };
	}
	try {
		const config = join(root, "config"),
			home = join(root, "home");
		await Promise.all([
			mkdir(cwd, { mode: 0o700 }),
			mkdir(config, { mode: 0o700 }),
			mkdir(home, { mode: 0o700 }),
		]);
		env.HOME = home;
		env.CLAUDE_CONFIG_DIR = config;
		const authentication = await subscriptionAuthentication(
			ambient,
			options.signal,
		);
		if (authentication) {
			await writeFile(
				join(config, ".credentials.json"),
				JSON.stringify(authentication),
				{ mode: 0o600, flag: "wx" },
			);
			// macOS normally uses Keychain rather than the JSON fallback. Pass only the copied OAuth token.
			env.CLAUDE_CODE_OAUTH_TOKEN = authentication.claudeAiOauth.accessToken;
		}
		return await new Promise<SubscriptionProcessResult>((resolve) => {
			let spawned = false;
			let reason: string | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let stdoutBytes = 0,
				stderrBytes = 0;
			const chunks: Buffer[] = [];
			const child = spawn(
				options.bin,
				[...configuration.argv, "--system-prompt", options.systemPrompt],
				{ cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false },
			);
			const stop = (code: string) => {
				if (reason) return;
				reason = code;
				child.kill("SIGTERM");
				killTimer = setTimeout(
					() => child.kill("SIGKILL"),
					Math.max(1, Math.min(options.killGraceMs ?? 5000, 5000)),
				);
			};
			const abort = () => stop("model_aborted");
			const timer = setTimeout(
				() => stop("model_timeout"),
				Math.max(1, Math.min(options.timeoutMs ?? 120_000, 120_000)),
			);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			child.on("spawn", () => {
				spawned = true;
			});
			child.on("error", () => {
				reason ??= "spawn_failed";
			});
			child.stdin.on("error", () => stop("model_stdin_failed"));
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > 65_536) stop("output_budget_exceeded");
				else chunks.push(chunk);
			});
			// Drain diagnostics without retaining or logging private/authentication text.
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > 65_536) stop("stderr_budget_exceeded");
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abort);
				if (reason || code !== 0 || !spawned) {
					resolve({
						ok: false,
						reason: reason ?? "model_exit_failed",
						spawned,
					});
					return;
				}
				try {
					resolve({
						ok: true,
						stdout: new TextDecoder("utf-8", { fatal: true }).decode(
							Buffer.concat(chunks),
						),
						spawned: true,
					});
				} catch {
					resolve({ ok: false, reason: "output_encoding_invalid", spawned });
				}
			});
			child.stdin.end(options.input);
		});
	} catch {
		return { ok: false, reason: "spawn_failed", spawned: false };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
