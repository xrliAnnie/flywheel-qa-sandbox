#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { collectSources, parseReportArgs } from "./lib/collect.mjs";
import { classifyVerdict } from "./lib/metrics.mjs";
import { analyzeSources, buildSuggestions } from "./lib/pipeline.mjs";
import { renderReport } from "./lib/render.mjs";

async function privateWrite(path, contents) {
	await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
}

export async function main() {
	const args = parseReportArgs(process.argv.slice(2));
	try {
		loadEnvFile(join(homedir(), ".flywheel", ".env"));
	} catch (error) {
		if (!process.env.LINEAR_API_KEY) throw error;
	}
	const outputDir = resolve(args.out);
	const qaEvidenceDir = join(dirname(outputDir), "qa-evidence");
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	await mkdir(qaEvidenceDir, { recursive: true, mode: 0o700 });
	const scratchDir = await mkdtemp(join(tmpdir(), "fly1327-cycle-time-"));
	const { bundle, manifests, qaLog } = await collectSources({
		...args,
		scratchDir,
		teamDb:
			process.env.FLYWHEEL_TEAMLEAD_DB ??
			join(homedir(), ".flywheel", "teamlead.db"),
		commDb:
			process.env.FLYWHEEL_COMM_DB ??
			join(homedir(), ".flywheel", "comm", args.project, "comm.db"),
		linearApiKey: process.env.LINEAR_API_KEY,
		healthRoot:
			process.env.FLYWHEEL_SYSTEM_HEALTH_DIR ??
			join(homedir(), "Library", "Logs", "system-health"),
	});
	const { reports, diagnostics } = analyzeSources(bundle);
	const verdict = classifyVerdict(reports);
	const suggestions = buildSuggestions(reports, diagnostics);

	for (const issue of args.issues) {
		const report = reports.find((item) => item.issue === issue);
		const payload = {
			schema_version: "cycle-time-v1",
			as_of: args.asOfIso,
			issue,
			report,
			diagnostics: diagnostics[issue] ?? null,
			manifests,
		};
		await privateWrite(
			join(outputDir, `data-${issue}.json`),
			`${JSON.stringify(payload, null, "\t")}\n`,
		);
	}
	await privateWrite(
		join(outputDir, "manifest.json"),
		`${JSON.stringify({ schema_version: "cycle-time-v1", as_of: args.asOfIso, manifests }, null, "\t")}\n`,
	);
	const html = renderReport({
		reports,
		verdict,
		manifests,
		suggestions,
		asOf: args.asOfIso,
	});
	if (Buffer.byteLength(html, "utf8") > 512 * 1024)
		throw new Error("rendered HTML exceeds publish-report 512 KiB limit");
	await privateWrite(join(outputDir, "cycle-time-report.html"), html);
	await privateWrite(
		join(qaEvidenceDir, "extraction-run.json"),
		`${JSON.stringify({ ...qaLog, analytics_files: args.issues.map((issue) => `data-${issue}.json`) }, null, "\t")}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({ ok: true, asOf: args.asOfIso, issues: args.issues, verdict: verdict.kind, outputDir, scratchDir })}\n`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		process.stderr.write(
			`[cycle-time-report] ${error.stack ?? error.message}\n`,
		);
		process.exitCode = 1;
	});
}
