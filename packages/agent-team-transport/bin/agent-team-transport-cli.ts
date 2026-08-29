#!/usr/bin/env node
/**
 * agent-team-transport CLI — shell-callable helper consumed by
 * `packages/teamlead/scripts/claude-lead.sh` (and any other shell launcher).
 *
 * Per plan v1.27.1 §2.0.4-bis (Codex r1 critical #2 + r2 high #4):
 *
 *   Bash launcher pattern (quote-safe via ANSI-C `$'...'` escaping +
 *   capture-then-eval — see PR 1.2 Codex r1 MEDIUM):
 *
 *     # Capture FIRST so command-substitution exit status propagates.
 *     # `eval "$(false)"` does NOT propagate failure under `set -e`.
 *     if ! lead_env_output=$(agent-team-transport lead-env --lead-id "${LEAD_ID}"); then
 *       echo "FATAL: agent-team-transport lead-env failed" >&2
 *       exit 1
 *     fi
 *     eval "${lead_env_output}"
 *
 *     if ! lead_args_output=$(agent-team-transport lead-args --lead-id "${LEAD_ID}"); then
 *       echo "FATAL: agent-team-transport lead-args failed" >&2
 *       exit 1
 *     fi
 *     eval "${lead_args_output}"
 *
 *     # Post-eval assertion (catches helper regression where output is
 *     # well-formed bash but doesn't actually export expected env).
 *     [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ] || {
 *       echo "FATAL: Agent Teams env not set" >&2; exit 1
 *     }
 *
 *     CLAUDE_ARGS+=( "${FLYWHEEL_AGENT_TEAM_ARGS[@]}" )
 *
 * Why `eval "$(...)"` not `source <(...)`: macOS ships bash 3.2 (GPL3
 * licensing), which lacks `declare -g`. `source <(...)` runs in a process
 * substitution that doesn't propagate variable assignments without `-g`.
 * `eval` runs in the parent shell, so plain `KEY=value` and `ARR=( ... )`
 * land in the parent scope. Safety is preserved by:
 *   1. DOUBLE-quoting `"$(...)"` — preserves CLI output as one string
 *      (no word-splitting at the eval boundary)
 *   2. CLI emits ANSI-C `$'...'` quoting on EVERY value — safe vs spaces,
 *      single-quotes, $VAR, newlines, etc.
 *
 * Output is `eval`-safe:
 *   - `lead-env`/`runner-env`: `export KEY=$'value'` lines
 *   - `lead-args`/`runner-args`: `FLYWHEEL_AGENT_TEAM_ARGS=( $'a' $'b' ... )`
 *
 * Subcommands:
 *   lead-env    --lead-id <id> [--team <name>] [--parent-session <uuid>]
 *   lead-args   --lead-id <id> [--team <name>] [--parent-session <uuid>]
 *   runner-env  --lead-id <lead> --runner <name> --team <name>
 *               [--parent-session <uuid>] [--color <c>] [--session-id <uuid>]
 *               [--permission-mode <m>]
 *   runner-args (same flags as runner-env)
 *   preflight                         (runs transport.preflight, exits non-zero on fail)
 *   vendor                            (prints vendor id to stdout — for shell branching)
 */

import process from "node:process";
import { AgentTeamTransportFactory } from "../src/AgentTeamTransportFactory.js";
import type {
	ILogger,
	LeadSpawnContext,
	RunnerSpawnContext,
} from "../src/types.js";

interface ParsedArgs {
	command: string;
	flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const command = argv[0] ?? "";
	const flags = new Map<string, string>();
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(key, next);
				i++;
			} else {
				flags.set(key, "true");
			}
		}
	}
	return { command, flags };
}

/**
 * Bash-quote a string using ANSI-C quoting (`$'...'`).
 * Mirrors `printf %q` semantics for arbitrary content (spaces, quotes,
 * newlines, $VAR, etc).
 */
function bashQuote(value: string): string {
	// $'...' supports \n, \t, \', \\, \uHHHH escapes.
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r");
	return `$'${escaped}'`;
}

function emitEnvAssignments(env: Record<string, string>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		// Validate key — letters, digits, underscores only.
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
			throw new Error(`Invalid env var name: ${key}`);
		}
		// `export` works on bash 3.2+ (no `-g` needed). Run via `eval "$(...)"`.
		lines.push(`export ${key}=${bashQuote(value)}`);
	}
	return lines.join("\n");
}

function emitArrayAssignment(varName: string, args: string[]): string {
	const quoted = args.map(bashQuote).join(" ");
	// Plain array assignment — propagates via `eval "$(...)"` on bash 3.2+
	// (where `declare -g` is unsupported).
	return `${varName}=( ${quoted} )`;
}

const stderrLogger: ILogger = {
	debug: (msg) => console.error(`[debug] ${msg}`),
	info: (msg) => console.error(`[info] ${msg}`),
	warn: (msg) => console.error(`[warn] ${msg}`),
	error: (msg) => console.error(`[error] ${msg}`),
};

function getRequired(flags: Map<string, string>, key: string): string {
	const value = flags.get(key);
	if (value === undefined) {
		throw new Error(`Missing required flag --${key}`);
	}
	return value;
}

function buildLeadCtx(flags: Map<string, string>): LeadSpawnContext {
	const leadId = getRequired(flags, "lead-id");
	const team = flags.get("team") ?? leadId;
	const ctx: LeadSpawnContext = {
		leadName: leadId,
		teamName: team,
	};
	const parentSession = flags.get("parent-session");
	if (parentSession !== undefined) {
		ctx.parentSessionId = parentSession;
	}
	const workspace = flags.get("workspace");
	if (workspace !== undefined) {
		ctx.workspace = workspace;
	}
	return ctx;
}

function buildRunnerCtx(flags: Map<string, string>): RunnerSpawnContext {
	const leadId = getRequired(flags, "lead-id");
	const runner = getRequired(flags, "runner");
	const team = flags.get("team") ?? leadId;
	const ctx: RunnerSpawnContext = {
		leadName: leadId,
		runnerName: runner,
		teamName: team,
	};
	const parentSession = flags.get("parent-session");
	if (parentSession !== undefined) {
		ctx.parentSessionId = parentSession;
	}
	const color = flags.get("color");
	if (color !== undefined) ctx.color = color;
	const sessionId = flags.get("session-id");
	if (sessionId !== undefined) ctx.sessionId = sessionId;
	const permissionMode = flags.get("permission-mode");
	if (permissionMode !== undefined) ctx.permissionMode = permissionMode;
	return ctx;
}

async function main(): Promise<void> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const transport = AgentTeamTransportFactory.fromEnv();

	switch (command) {
		case "lead-env": {
			const cfg = transport.buildLeadSpawnConfig(buildLeadCtx(flags));
			console.log(emitEnvAssignments(cfg.env));
			break;
		}
		case "lead-args": {
			const cfg = transport.buildLeadSpawnConfig(buildLeadCtx(flags));
			console.log(emitArrayAssignment("FLYWHEEL_AGENT_TEAM_ARGS", cfg.args));
			break;
		}
		case "runner-env": {
			const cfg = transport.buildRunnerSpawnConfig(buildRunnerCtx(flags));
			console.log(emitEnvAssignments(cfg.env));
			break;
		}
		case "runner-args": {
			const cfg = transport.buildRunnerSpawnConfig(buildRunnerCtx(flags));
			console.log(emitArrayAssignment("FLYWHEEL_AGENT_TEAM_ARGS", cfg.args));
			break;
		}
		case "preflight": {
			const result = await transport.preflight({ logger: stderrLogger });
			console.log(JSON.stringify(result, null, 2));
			if (!result.ok) {
				process.exit(1);
			}
			break;
		}
		case "vendor":
			console.log(transport.vendorId());
			break;
		case "":
		case "--help":
		case "help":
			printHelp();
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exit(2);
	}
}

function printHelp(): void {
	console.error(
		`Usage: agent-team-transport <command> [flags]

Commands:
  lead-env    --lead-id <id> [--team <name>] [--parent-session <uuid>]
                  Emits 'export KEY=$\\'value\\'' lines for eval.
  lead-args   --lead-id <id> [--team <name>] [--parent-session <uuid>]
                  Emits 'FLYWHEEL_AGENT_TEAM_ARGS=( $\\'a\\' $\\'b\\' ... )' for eval.
  runner-env  --lead-id <lead> --runner <name> --team <name>
                  [--parent-session <uuid>] [--color <c>] [--session-id <uuid>]
                  [--permission-mode <m>]
  runner-args (same flags as runner-env)
  preflight                Run transport.preflight() and exit non-zero on failure.
  vendor                   Print vendor id (claude-code | codex).

Backend selected by FLYWHEEL_AGENT_BACKEND env (default: claude-code).

Shell launcher integration (bash 3.2+ compat + capture-then-eval per
PR 1.2 Codex r1 — \`eval "$(...)"\` does NOT propagate command-sub failures):

  if ! lead_env=$(agent-team-transport lead-env --lead-id "\${LEAD_ID}"); then
    echo "FATAL" >&2; exit 1
  fi
  eval "\${lead_env}"

  if ! lead_args=$(agent-team-transport lead-args --lead-id "\${LEAD_ID}"); then
    echo "FATAL" >&2; exit 1
  fi
  eval "\${lead_args}"

  [ "\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ] || {
    echo "FATAL: env not set" >&2; exit 1
  }
  CLAUDE_ARGS+=( "\${FLYWHEEL_AGENT_TEAM_ARGS[@]}" )

See plan v1.27.1 §2.0.4-bis for full launcher pattern + safety rationale.`,
	);
}

main().catch((err) => {
	console.error(`agent-team-transport: ${(err as Error).message}`);
	process.exit(2);
});
