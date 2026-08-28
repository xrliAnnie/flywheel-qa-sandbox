import { normalizeOptionalBearer } from "flywheel-config";
import {
	type AlertDutyProject,
	resolveAlertDutySeat,
} from "./alert-duty-seat.js";
import { loadProjects } from "./ProjectConfig.js";

export interface AlertDutySeatProbe {
	dispatcherBotUserId: string | null;
}

export async function queryAlertDutySeat(
	bridgeUrl: string,
	fetchImpl: typeof fetch = fetch,
	apiToken?: string,
): Promise<AlertDutySeatProbe> {
	const token = normalizeOptionalBearer(apiToken);
	const response = await fetchImpl(
		`${bridgeUrl.replace(/\/$/, "")}/api/alert-duty/seat`,
		{
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(5_000),
		},
	);
	if (!response.ok) {
		throw new Error(`Bridge seat probe returned ${response.status}`);
	}
	const body = (await response.json()) as Record<string, unknown>;
	return {
		dispatcherBotUserId:
			typeof body.dispatcherBotUserId === "string" &&
			body.dispatcherBotUserId.trim()
				? body.dispatcherBotUserId.trim()
				: null,
	};
}

export async function buildAlertDutySeatReport(input: {
	leadId: string;
	projectName: string;
	projects: AlertDutyProject[];
	env: Readonly<Record<string, string | undefined>>;
	bridgeUrl: string;
	apiToken?: string;
	fetchImpl?: typeof fetch;
}): Promise<ReturnType<typeof resolveAlertDutySeat> & AlertDutySeatProbe> {
	const seat = resolveAlertDutySeat(input);
	const probe = await queryAlertDutySeat(
		input.bridgeUrl,
		input.fetchImpl,
		input.apiToken,
	);
	return { ...seat, ...probe };
}

export interface AlertDutySeatCliOptions {
	env?: Readonly<Record<string, string | undefined>>;
	loadProjects?: () => AlertDutyProject[];
	fetchImpl?: typeof fetch;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
}

function valueAfter(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function loadProjectsFromOptionalFile(
	projectsFile?: string,
): AlertDutyProject[] {
	if (!projectsFile) return loadProjects();
	const previousFile = process.env.FLYWHEEL_PROJECTS_FILE;
	const previousInline = process.env.FLYWHEEL_PROJECTS;
	try {
		process.env.FLYWHEEL_PROJECTS_FILE = projectsFile;
		delete process.env.FLYWHEEL_PROJECTS;
		return loadProjects();
	} finally {
		if (previousFile === undefined) delete process.env.FLYWHEEL_PROJECTS_FILE;
		else process.env.FLYWHEEL_PROJECTS_FILE = previousFile;
		if (previousInline === undefined) delete process.env.FLYWHEEL_PROJECTS;
		else process.env.FLYWHEEL_PROJECTS = previousInline;
	}
}

export async function runAlertDutySeatCli(
	argv: string[],
	opts: AlertDutySeatCliOptions = {},
): Promise<number> {
	const writeStdout =
		opts.writeStdout ?? ((text) => process.stdout.write(text));
	const writeStderr =
		opts.writeStderr ?? ((text) => process.stderr.write(text));
	const env = opts.env ?? process.env;
	const leadId = valueAfter(argv, "lead-id")?.trim();
	const projectName = valueAfter(argv, "project")?.trim();
	if (!leadId || !projectName) {
		writeStderr(
			"[alert-duty] usage: --lead-id <id> --project <name> [--projects-file <path>] [--bridge-url <url>]\n",
		);
		return 2;
	}

	let projects: AlertDutyProject[];
	try {
		projects = opts.loadProjects
			? opts.loadProjects()
			: loadProjectsFromOptionalFile(valueAfter(argv, "projects-file"));
	} catch (error) {
		writeStderr(
			`[alert-duty] projects load failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 3;
	}

	const bridgeUrl =
		valueAfter(argv, "bridge-url")?.trim() ||
		env.FLYWHEEL_BRIDGE_URL?.trim() ||
		`http://127.0.0.1:${env.TEAMLEAD_PORT?.trim() || "9876"}`;
	const seat = resolveAlertDutySeat({ leadId, projectName, projects, env });
	let dispatcherBotUserId: string | null = null;
	try {
		dispatcherBotUserId = (
			await queryAlertDutySeat(
				bridgeUrl,
				opts.fetchImpl,
				env.TEAMLEAD_API_TOKEN,
			)
		).dispatcherBotUserId;
	} catch (error) {
		writeStderr(
			`[alert-duty] Bridge seat probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	writeStdout(`${JSON.stringify({ ...seat, dispatcherBotUserId })}\n`);
	return 0;
}

const invokedPath = process.argv[1] ?? "";
if (
	invokedPath.endsWith("alert-duty-seat-cli.js") ||
	invokedPath.endsWith("alert-duty-seat-cli.ts")
) {
	void runAlertDutySeatCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
