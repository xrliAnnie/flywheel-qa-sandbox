#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BEGIN = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
const END = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";

function prependPolicy(value, policy) {
	if (typeof value !== "string") return value;
	if (value.startsWith(BEGIN)) return value;
	return `${policy}\n\n${value}`;
}

export function rewriteDelegatedToolInput(toolName, input, policy) {
	if (!input || typeof input !== "object" || !policy.startsWith(BEGIN)) {
		return input;
	}
	if (toolName === "Agent" || toolName === "Task") {
		if (typeof input.prompt !== "string") return input;
		return { ...input, prompt: prependPolicy(input.prompt, policy) };
	}
	if (
		toolName === "Skill" &&
		typeof input.skill === "string" &&
		/(?:^|:)(?:codex-rescue|rescue|codex-code-review|code-review)$/i.test(
			input.skill,
		) &&
		typeof input.args === "string"
	) {
		return { ...input, args: prependPolicy(input.args, policy) };
	}
	return input;
}

function canonicalPolicy() {
	const paths = [
		"../../packages/teamlead/phase-protocols/local-test-policy.md",
		"../../node_modules/flywheel-teamlead/phase-protocols/local-test-policy.md",
	].map((relativePath) =>
		fileURLToPath(new URL(relativePath, import.meta.url)),
	);
	const path = paths.find((candidate) => existsSync(candidate));
	if (!path) {
		throw new Error("canonical local-test policy is missing");
	}
	const policy = readFileSync(path, "utf8").trim();
	if (!policy.startsWith(BEGIN) || !policy.endsWith(END)) {
		throw new Error("canonical local-test policy markers are incomplete");
	}
	return policy;
}

async function main() {
	try {
		let source = "";
		for await (const chunk of process.stdin) source += chunk;
		const event = JSON.parse(source);
		const input = event.tool_input;
		const updatedInput = rewriteDelegatedToolInput(
			event.tool_name,
			input,
			canonicalPolicy(),
		);
		if (updatedInput === input) return;
		// No permissionDecision: Claude Code applies updatedInput and still runs
		// the normal permission checks, so rewriting never auto-approves a call.
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					updatedInput,
				},
			}),
		);
	} catch (error) {
		// Prompt injection is an evidence hardening layer. A malformed hook event
		// must not wedge the runner; the observer still fails closed on missing
		// policy, and this one-line diagnostic says why the policy was not added.
		const reason =
			error instanceof SyntaxError
				? "malformed hook event JSON"
				: typeof error?.code === "string"
					? `filesystem error ${error.code}`
					: String(error?.message ?? error);
		process.stderr.write(
			`inject-runner-test-policy: delegated prompt left without local-test policy: ${reason.replace(/\s+/g, " ")}\n`,
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
