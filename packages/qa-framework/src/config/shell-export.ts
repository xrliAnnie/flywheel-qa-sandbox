/**
 * Shell Export Bridge — converts typed QaConfig to shell-safe export statements.
 *
 * Usage: node dist/config/shell-export.js <path-to-qa-config.yaml>
 * Output: shell export statements, intended to be eval'd by orchestrator scripts.
 *
 * The orchestrator's config-bridge.sh sources the output:
 *   eval "$(node .../shell-export.js .claude/qa-config.yaml)"
 */
import { readFile } from "node:fs/promises";
import { QaConfigLoader } from "./QaConfigLoader.js";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function exportLine(key: string, value: string | number | null): string {
	if (value === null || value === undefined || value === "") {
		return `export ${key}=''`;
	}
	if (typeof value === "number") {
		return `export ${key}=${value}`;
	}
	return `export ${key}=${shellQuote(value)}`;
}

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (!configPath) {
		process.stderr.write(
			"Usage: node shell-export.js <path-to-qa-config.yaml>\n",
		);
		process.exit(1);
	}

	const loader = new QaConfigLoader((p) => readFile(p, "utf-8"));
	const config = await loader.load(configPath);

	const lines: string[] = [];

	// Project metadata
	lines.push(exportLine("QA_PROJECT_NAME", config.project.name));
	lines.push(exportLine("QA_PROJECT_DESC", config.project.description));

	// QA paths
	lines.push(exportLine("QA_DOC_ROOT", config.qa.doc_root));
	lines.push(exportLine("QA_REPORT_DIR", config.qa.test_report_dir));
	lines.push(exportLine("QA_CONTEXT_FILE", config.qa.context_file ?? ""));

	// Plan source
	const plan = config.plan ?? {
		source: "worktree",
		fetch_strategy: "checkout_file",
	};
	lines.push(exportLine("QA_PLAN_SOURCE", plan.source));
	lines.push(exportLine("QA_PLAN_FETCH_STRATEGY", plan.fetch_strategy));

	// Domains
	lines.push(exportLine("QA_DOMAIN_COUNT", config.domains.length));
	for (const [i, domain] of config.domains.entries()) {
		const prefix = `QA_DOMAIN_${i}`;
		lines.push(exportLine(`${prefix}_NAME`, domain.name));
		lines.push(exportLine(`${prefix}_DIR`, domain.dir));
		lines.push(exportLine(`${prefix}_SKILL`, domain.test_skill));
		lines.push(exportLine(`${prefix}_CONFIG`, domain.config_file));
		lines.push(exportLine(`${prefix}_CLEANUP`, domain.cleanup_script ?? ""));
	}

	// API config
	lines.push(exportLine("QA_API_OPENAPI_SPEC", config.api?.openapi_spec ?? ""));
	lines.push(exportLine("QA_API_BASE_URL", config.api?.base_url ?? ""));

	// Orchestrator
	lines.push(exportLine("QA_ORCH_DB_PATH", config.orchestrator.db_path));
	lines.push(
		exportLine("QA_ORCH_MAX_AGENTS", config.orchestrator.max_concurrent_agents),
	);
	lines.push(
		exportLine(
			"QA_ORCH_RETENTION_DAYS",
			config.orchestrator.artifact_retention_days,
		),
	);

	// Agent type step templates
	for (const agentType of config.orchestrator.agent_types) {
		// Sanitize: only allow [a-zA-Z0-9_] in env var names to prevent injection
		const safeTypeName = agentType.name.replace(/[^a-zA-Z0-9]/g, "_");
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(safeTypeName)) {
			throw new Error(
				`Invalid agent type name for env var: "${agentType.name}"`,
			);
		}
		const prefix = `QA_AGENT_TYPE_${safeTypeName}`;
		lines.push(
			exportLine(`${prefix}_STEP_COUNT`, agentType.step_templates.length),
		);
		for (const [j, step] of agentType.step_templates.entries()) {
			lines.push(exportLine(`${prefix}_STEP_${j}_KEY`, step.key));
			lines.push(exportLine(`${prefix}_STEP_${j}_NAME`, step.name));
			lines.push(exportLine(`${prefix}_STEP_${j}_ORDER`, step.order));
			lines.push(
				exportLine(`${prefix}_STEP_${j}_PREREQ`, step.prerequisite ?? ""),
			);
		}
	}

	// Version
	lines.push(exportLine("QA_VERSION_FILE", config.version?.file ?? ""));

	// Env refs
	if (config.env_refs) {
		const keys = Object.keys(config.env_refs);
		lines.push(exportLine("QA_ENV_REF_COUNT", keys.length));
		for (const [i, key] of keys.entries()) {
			lines.push(exportLine(`QA_ENV_REF_${i}_KEY`, key));
			const envVar = config.env_refs[key];
			if (envVar !== undefined) {
				lines.push(exportLine(`QA_ENV_REF_${i}_VAR`, envVar));
			}
		}
	}

	process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((err) => {
	process.stderr.write(
		`Error: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
