import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	buildTmuxServerBirthEnvironment,
	RUNNER_PANE_BASE_ALLOWLIST,
} from "flywheel-claude-runner";
import { sanitizeTmuxName } from "flywheel-core";
import type { ProjectEntry } from "../ProjectConfig.js";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_EXACT = new Set([
	"LEAD_ID",
	"DISCORD_STATE_DIR",
	"DISCORD_BOT_TOKEN",
	"TEAMLEAD_API_TOKEN",
	"BRIDGE_URL",
	"PROJECT_NAME",
	"CODEX_HOME",
	"FLYWHEEL_CODEX_BIN",
]);
const FORBIDDEN_PREFIXES = [
	"FLYWHEEL_CODEX_LEAD_",
	"FLYWHEEL_CODEX_TUI_",
	"FLYWHEEL_LEAD_",
	"DISCORD_",
] as const;
const PRESERVED = new Set<string>(RUNNER_PANE_BASE_ALLOWLIST);
export const TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS = 10_000;

export function parseEnvFileVariableNames(contents: string): Set<string> {
	const names = new Set<string>();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match?.[1]) names.add(match[1]);
	}
	return names;
}

function currentEnvironmentNames(stdout: string): string[] {
	const names: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const equals = line.indexOf("=");
		const name = equals < 0 ? "" : line.slice(0, equals);
		if (ENVIRONMENT_NAME.test(name)) names.push(name);
	}
	return names;
}

type ExecResult = { ok: boolean; stdout: string; timedOut?: boolean };

export interface TmuxEnvironmentScrubOptions {
	env?: NodeJS.ProcessEnv;
	readFile?: (path: string) => string;
	exec?: (args: string[], timeoutMs: number) => ExecResult;
	log?: (line: string) => void;
	now?: () => number;
}

function defaultExec(
	args: string[],
	sourceEnv: NodeJS.ProcessEnv,
	socket: string,
	timeoutMs: number,
): ExecResult {
	try {
		const result = spawnSync("tmux", ["-S", socket, ...args], {
			encoding: "utf8",
			timeout: timeoutMs,
			env: buildTmuxServerBirthEnvironment(sourceEnv),
		});
		return {
			ok: result.status === 0,
			stdout: result.stdout ?? "",
			timedOut:
				(result.error as NodeJS.ErrnoException | undefined)?.code ===
				"ETIMEDOUT",
		};
	} catch {
		return { ok: false, stdout: "" };
	}
}

function implicitTmuxSocket(env: NodeJS.ProcessEnv): string | null {
	const attachedSocket = env.TMUX?.split(",", 1)[0]?.trim();
	if (attachedSocket) return isAbsolute(attachedSocket) ? attachedSocket : null;
	const root = env.TMUX_TMPDIR?.trim() || "/tmp";
	const uid = process.getuid?.();
	if (!isAbsolute(root) || !Number.isSafeInteger(uid) || (uid ?? -1) < 0) {
		return null;
	}
	try {
		return join(realpathSync(root), `tmux-${uid}`, "default");
	} catch {
		return null;
	}
}

/** Idempotently removes inherited Lead identity and secrets from managed tmux scopes. */
export function scrubManagedTmuxEnvironments(
	projects: Pick<ProjectEntry, "projectName">[],
	options: TmuxEnvironmentScrubOptions = {},
): { scopesScrubbed: number; namesRemoved: number } {
	const sourceEnv = options.env ?? process.env;
	const log = options.log ?? (() => {});
	const override = sourceEnv.FLYWHEEL_TMUX_SOCKET_OVERRIDE?.trim();
	if (override && !isAbsolute(override)) {
		log("[tmux-env-scrub] skipped: invalid tmux socket override");
		return { scopesScrubbed: 0, namesRemoved: 0 };
	}
	const socket = override || implicitTmuxSocket(sourceEnv);
	if (!socket) {
		log("[tmux-env-scrub] skipped: tmux socket unresolved");
		return { scopesScrubbed: 0, namesRemoved: 0 };
	}
	const exec =
		options.exec ??
		((args, timeoutMs) => defaultExec(args, sourceEnv, socket, timeoutMs));
	const now = options.now ?? Date.now;
	const deadline = now() + TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS;
	const run = (args: string[]): ExecResult => {
		const remaining = deadline - now();
		return remaining <= 0
			? { ok: false, stdout: "", timedOut: true }
			: exec(args, remaining);
	};
	if (!override) {
		const expectedSessions = new Set(
			projects.map((project) =>
				sanitizeTmuxName(`runner-${project.projectName}`),
			),
		);
		const ownership = run(["list-sessions", "-F", "#{session_name}"]);
		if (ownership.timedOut) {
			log(
				`[tmux-env-scrub] timed out after ${TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS}ms`,
			);
			return { scopesScrubbed: 0, namesRemoved: 0 };
		}
		if (
			!ownership.ok ||
			!ownership.stdout
				.split(/\r?\n/)
				.some((session) => expectedSessions.has(session))
		) {
			log("[tmux-env-scrub] skipped: tmux server ownership unproven");
			return { scopesScrubbed: 0, namesRemoved: 0 };
		}
	}
	const envNames = new Set<string>();
	const envPath = sourceEnv.FLYWHEEL_STATE_DIR
		? join(sourceEnv.FLYWHEEL_STATE_DIR, ".env")
		: join(sourceEnv.HOME ?? homedir(), ".flywheel", ".env");
	try {
		for (const name of parseEnvFileVariableNames(
			(options.readFile ?? ((path) => readFileSync(path, "utf8")))(envPath),
		)) {
			envNames.add(name);
		}
	} catch (error) {
		log(
			`[tmux-env-scrub] env-name ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "file missing" : "read failed"}: ${envPath}`,
		);
	}

	const scopes = [
		{ label: "global", show: ["show-environment", "-g"], mutate: ["-g"] },
		...[
			...new Set([
				"flywheel",
				...projects.map((project) =>
					sanitizeTmuxName(`runner-${project.projectName}`),
				),
			]),
		].map((session) => ({
			label: session,
			show: ["show-environment", "-t", `=${session}`],
			mutate: ["-t", `=${session}`],
		})),
	];
	const canonical = buildTmuxServerBirthEnvironment(sourceEnv);
	let scopesScrubbed = 0;
	let namesRemoved = 0;
	for (const [index, scope] of scopes.entries()) {
		const shown = run(scope.show);
		if (shown.timedOut) {
			log(
				`[tmux-env-scrub] timed out after ${TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS}ms`,
			);
			break;
		}
		if (!shown.ok) {
			if (index === 0) log("[tmux-env-scrub] skipped: tmux server unavailable");
			if (index === 0) break;
			continue;
		}
		const remove = currentEnvironmentNames(shown.stdout)
			.filter(
				(name) =>
					!PRESERVED.has(name) &&
					(envNames.has(name) ||
						FORBIDDEN_EXACT.has(name) ||
						FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))),
			)
			.sort();
		const command: string[] = [];
		for (const name of remove) {
			if (command.length > 0) command.push(";");
			command.push("set-environment", ...scope.mutate, "-u", name);
		}
		if (command.length > 0) command.push(";");
		command.push(
			"set-environment",
			...scope.mutate,
			"PATH",
			canonical.PATH ?? "",
		);
		const mutated = run(command);
		if (mutated.timedOut) {
			log(
				`[tmux-env-scrub] timed out after ${TMUX_ENVIRONMENT_SCRUB_TIMEOUT_MS}ms`,
			);
			break;
		}
		if (!mutated.ok) {
			log(`[tmux-env-scrub] scope failed: ${scope.label}`);
			continue;
		}
		scopesScrubbed += 1;
		namesRemoved += remove.length;
	}
	return { scopesScrubbed, namesRemoved };
}
