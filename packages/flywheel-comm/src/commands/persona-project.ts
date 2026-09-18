import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolvePersonaStateRoot } from "flywheel-config";
import {
	type PersonaProjectSelector,
	projectPersona,
} from "../persona-projector.js";
import { runLeadRegistryCommand } from "./lead-registry.js";

export interface PersonaProjectCommandDeps {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

function select(
	project: string,
	lead: string,
	projectsFile: string,
	homeDir: string,
): PersonaProjectSelector {
	const output: string[] = [];
	const errors: string[] = [];
	const code = runLeadRegistryCommand(
		[
			"selector",
			"--project",
			project,
			"--lead",
			lead,
			"--projects-file",
			projectsFile,
		],
		{
			homeDir,
			stdout: (line) => output.push(line),
			stderr: (line) => errors.push(line),
		},
	);
	if (code !== 0 || output.length !== 1) {
		throw new Error(errors.join("; ") || "persona_selector_failed");
	}
	return JSON.parse(output[0]!) as PersonaProjectSelector;
}

export async function runPersonaProject(
	args: string[],
	deps: PersonaProjectCommandDeps = {},
): Promise<number> {
	const emit = deps.stdout ?? console.log;
	const diagnostic = deps.stderr ?? console.error;
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args,
			options: {
				project: { type: "string" },
				lead: { type: "string" },
				"projects-file": { type: "string" },
				"bridge-url": { type: "string" },
			},
			allowPositionals: false,
			strict: true,
			tokens: true,
		});
		const names = parsed.tokens
			.filter((token) => token.kind === "option")
			.map((token) => token.name);
		if (new Set(names).size !== names.length)
			throw new Error("duplicate option");
		values = parsed.values;
	} catch {
		diagnostic("persona-project: use --project <project> --lead <lead>");
		return 64;
	}
	if (!values.project || !values.lead) {
		diagnostic("persona-project: project and lead are required");
		return 64;
	}
	const env = deps.env ?? process.env;
	const home = deps.homeDir ?? homedir();
	const projectsFile =
		values["projects-file"] ?? join(home, ".flywheel", "projects.json");
	let selector: PersonaProjectSelector;
	try {
		selector = select(values.project, values.lead, projectsFile, home);
	} catch (error) {
		emit(
			JSON.stringify({
				status: "refused",
				reason:
					error instanceof Error ? error.message : "persona_selector_failed",
			}),
		);
		return 78;
	}
	if (selector.projectName !== "raya" || selector.leadId !== "raya") {
		const result = await projectPersona(selector, { stateRoot: "" });
		emit(JSON.stringify(result));
		return result.status === "refused" ? 78 : 0;
	}
	let stateRoot: string;
	try {
		stateRoot = resolvePersonaStateRoot(env, home);
	} catch (error) {
		emit(
			JSON.stringify({
				status: "refused",
				reason:
					error instanceof Error ? error.message : "persona_state_root_invalid",
			}),
		);
		return 78;
	}
	if (!selector.personaProjection) {
		try {
			for (const marker of ["enrollment.json", "activation.json"] as const) {
				try {
					lstatSync(join(stateRoot, marker));
					emit(
						JSON.stringify({
							status: "refused",
							reason: "enrolled_contract_missing",
						}),
					);
					return 78;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} catch (error) {
			emit(
				JSON.stringify({
					status: "refused",
					reason:
						error instanceof Error
							? error.message
							: "persona_state_unavailable",
				}),
			);
			return 78;
		}
		const result = await projectPersona(selector, { stateRoot });
		emit(JSON.stringify(result));
		return 0;
	}
	const readSelector = () =>
		select(values.project!, values.lead!, projectsFile, home);
	const result = await projectPersona(selector, {
		stateRoot,
		env,
		bridgeUrl:
			values["bridge-url"] ??
			env.FLYWHEEL_BRIDGE_URL ??
			env.BRIDGE_URL ??
			"http://localhost:9876",
		bridgeToken: env.TEAMLEAD_API_TOKEN ?? env.FLYWHEEL_API_TOKEN,
		readSelector,
	});
	emit(JSON.stringify(result));
	if (result.status === "fallback") {
		diagnostic(
			`persona-project: authorized fallback ${result.source} ${result.personaBlobDigest}`,
		);
	}
	return result.status === "refused" ? 78 : 0;
}
