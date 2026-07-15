#!/usr/bin/env node
/**
 * FLY-1018 CLI — test/E2E entry shell (plan §2.1):
 *
 *   flywheel-gemini-agent run "<instruction>" --project <p> --lead <leadId>
 *                          [--identity <path>] [--resume <sessionId>]
 *   flywheel-gemini-agent daemon        (M2 Discord entry)
 *
 * Fail-closed: FLYWHEEL_GEMINI_AGENT unset, missing env, or missing
 * --project/--lead refuse to start (Terminal reason config_error semantics —
 * exit 2). No invented default Lead: the binding is explicit (Codex R3-1).
 */

import { ConfigError, loadAgentConfig } from "./config.js";
import { runAgentSession } from "./session.js";

interface ParsedArgs {
	command: string | undefined;
	positional: string[];
	flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg?.startsWith("--")) {
			const key = arg.slice(2);
			const value = rest[i + 1];
			if (value === undefined || value.startsWith("--")) {
				flags[key] = "";
			} else {
				flags[key] = value;
				i++;
			}
		} else if (arg !== undefined) {
			positional.push(arg);
		}
	}
	return { command, positional, flags };
}

const USAGE = `Usage:
  flywheel-gemini-agent run "<instruction>" --project <projectName> --lead <leadId> [--dept-label <label>] [--identity <identity.md>] [--context "<note>"] [--resume <sessionId>]
  flywheel-gemini-agent daemon`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const { command, positional, flags } = parseArgs(argv);

	if (command === "run") {
		const instruction = positional[0];
		if (!instruction || !flags.project || !flags.lead) {
			console.error(USAGE);
			console.error(
				"\nrun requires an instruction plus explicit --project and --lead (no default Lead is ever invented).",
			);
			return 2;
		}
		let config: ReturnType<typeof loadAgentConfig>;
		try {
			config = loadAgentConfig();
		} catch (err) {
			if (err instanceof ConfigError) {
				console.error(`config_error: ${err.message}`);
				return 2;
			}
			throw err;
		}

		const ac = new AbortController();
		process.on("SIGINT", () => ac.abort());

		const { sessionId, terminal } = await runAgentSession({
			config,
			binding: {
				projectName: flags.project,
				leadId: flags.lead,
				...(flags["dept-label"] && { deptLabel: flags["dept-label"] }),
			},
			userText: instruction,
			entry: "cli",
			identityPath: flags.identity || undefined,
			contextNote: flags.context || undefined,
			signal: ac.signal,
			resumeSessionId: flags.resume || undefined,
			onEvent: (e) => {
				if (e.type === "tool_dispatch") console.error(`[tool] ${e.tool} ...`);
				if (e.type === "tool_result")
					console.error(
						`[tool] ${e.tool} ${e.ok ? "ok" : "ERROR"} (${e.durationMs}ms)`,
					);
			},
		});

		console.error(
			`[session ${sessionId}] ${terminal.reason} — steps=${terminal.stats.steps} tools=${terminal.stats.toolCalls} (${terminal.stats.toolErrors} err, ${terminal.stats.hallucinatedToolCalls} hallucinated) tokens=${terminal.stats.inputTokens}/${terminal.stats.outputTokens} ${terminal.stats.durationMs}ms`,
		);
		if (terminal.reason === "completed") {
			console.log(terminal.finalText ?? "");
			return 0;
		}
		if (terminal.error) {
			console.error(`error(${terminal.error.kind}): ${terminal.error.message}`);
		}
		return 1;
	}

	if (command === "daemon") {
		// M2: Discord entry — wired in the daemon chunk.
		const { runDaemon } = await import("./discord/daemon.js");
		return runDaemon();
	}

	console.error(USAGE);
	return 2;
}

// Only run when invoked as a script (not when imported by tests).
if (
	process.argv[1]?.endsWith("/cli.js") ||
	process.argv[1]?.endsWith("/flywheel-gemini-agent")
) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(err);
			process.exit(1);
		},
	);
}
