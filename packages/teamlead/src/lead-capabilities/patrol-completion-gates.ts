import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { validatePatrolReport } from "../patrol-report.js";
import { readManifestMarkdown } from "./manifest-instructions.js";

type PinnedMarkdown = { path: string; sha256: string };
/** Execute exactly the approved rule source's three gates. The caller owns the
 * report and supplies its post-write digest; paths/data never become shell code. */
export function runPatrolCompletionGates(options: {
	source: PinnedMarkdown;
	report: PinnedMarkdown;
	secrets: readonly string[];
	assertCurrent(): void;
}) {
	function current() {
		options.assertCurrent();
		if (realpathSync(options.report.path) !== options.report.path)
			throw new Error("patrol_report_unverified");
		readManifestMarkdown([options.report], options.secrets);
		return readManifestMarkdown([options.source], options.secrets)[0]!;
	}
	const rule = current();
	const lines = rule.split("\n");
	const select = (prefix: string) => {
		const matches = lines
			.map((line) => line.trim())
			.filter((line) => line.startsWith(prefix));
		if (matches.length !== 1 || !matches[0]!.endsWith("`。"))
			throw new Error("patrol_gates_unverified");
		return matches[0]!.slice(1, -2);
	};
	const findings = [
		...rule.matchAll(
			/^# FLY-2080-FINDING-GATE-BEGIN\n([\s\S]*?)\n# FLY-2080-FINDING-GATE-END$/gm,
		),
	];
	if (
		findings.length !== 1 ||
		!findings[0]![1]!.startsWith("awk '\n") ||
		!findings[0]![1]!.endsWith(`' "$REPORT_PATH"`)
	)
		throw new Error("patrol_gates_unverified");
	const programs = [
		select("`FINAL_STEP_COUNT="),
		select("`awk '/^## STEP 5$/{in5=1;next}"),
		findings[0]![1]!,
	];
	const gates = programs.map((program, index) => {
		current();
		let exitCode: number | null = 0;
		try {
			execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", program], {
				cwd: "/",
				timeout: 3000,
				maxBuffer: 4096,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: "/usr/bin:/bin",
					HOME: "/var/empty",
					LC_ALL: "C",
					REPORT_PATH: options.report.path,
				},
			});
		} catch (error) {
			const status = (error as { status?: unknown }).status;
			exitCode = typeof status === "number" ? status : null;
		}
		current();
		if (
			index === 2 &&
			!validatePatrolReport(
				readManifestMarkdown([options.report], options.secrets)[0]!,
			).valid
		)
			exitCode = 1;
		return { gate: index + 1, passed: exitCode === 0, exitCode };
	});
	return {
		complete: gates.every((gate) => gate.passed),
		gates,
		reportSha256: options.report.sha256,
		ruleSha256: options.source.sha256,
	};
}
