import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { normalizeOptionalBearer } from "flywheel-config";

export interface VoiceSessionCommandDeps {
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalMeetingStateDir(
	env: Readonly<Record<string, string | undefined>>,
): string {
	const configPath = resolve(
		env.FLYWHEEL_MEETING_NOTES_CONFIG ??
			join(
				env.FLYWHEEL_DIR ?? process.cwd(),
				".flywheel",
				"meeting-notes.yaml",
			),
	);
	const configInfo = lstatSync(configPath);
	if (configInfo.isSymbolicLink() || !configInfo.isFile()) {
		throw new Error(
			"meeting-notes config must be a regular non-symlinked file",
		);
	}
	const matches = [
		...readFileSync(configPath, "utf8").matchAll(
			/^meetingStateDir:[ \t]*(.*)$/gm,
		),
	];
	if (matches.length !== 1) {
		throw new Error("meeting-notes config must define meetingStateDir once");
	}
	const scalar = matches[0]![1]!.replace(/\s+#.*$/, "").trim();
	const configured =
		scalar.startsWith('"') && scalar.endsWith('"')
			? JSON.parse(scalar)
			: scalar.startsWith("'") && scalar.endsWith("'")
				? scalar.slice(1, -1).replace(/''/g, "'")
				: scalar;
	if (typeof configured !== "string" || !isAbsolute(configured)) {
		throw new Error("meetingStateDir must be absolute");
	}
	const stateInfo = lstatSync(configured);
	if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
		throw new Error("meetingStateDir must be a non-symlinked directory");
	}
	const canonical = realpathSync(configured);
	if (canonical === sep) throw new Error("meetingStateDir must not be root");
	return canonical;
}

export async function runVoiceSessionCommand(
	args: string[],
	deps: VoiceSessionCommandDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	const env = deps.env ?? process.env;
	let requestStarted = false;
	try {
		const request = async (
			path: string,
			method: "GET" | "POST",
			body?: unknown,
		): Promise<{ response: Response; body: unknown }> => {
			const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL)?.trim();
			const token =
				normalizeOptionalBearer(env.TEAMLEAD_API_TOKEN) ??
				normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
			if (!bridgeUrl || !token) {
				throw new Error(
					"FLYWHEEL_BRIDGE_URL and TEAMLEAD_API_TOKEN or FLYWHEEL_INGEST_TOKEN are required",
				);
			}
			requestStarted = true;
			const response = await (deps.fetchImpl ?? fetch)(
				`${bridgeUrl.replace(/\/+$/, "")}${path}`,
				{
					method,
					headers: {
						Authorization: `Bearer ${token}`,
						...(body === undefined
							? {}
							: { "Content-Type": "application/json" }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
			);
			return { response, body: (await response.json()) as unknown };
		};
		const finish = ({
			response,
			body,
		}: Awaited<ReturnType<typeof request>>) => {
			stdout(JSON.stringify(body));
			if (response.ok) return 0;
			stderr(`voice-session: Bridge rejected (HTTP ${response.status})`);
			return 2;
		};
		const subcommand = args[0];
		if (subcommand === "stop" || subcommand === "status") {
			const { values } = parseArgs({
				args: args.slice(1),
				options: {
					session: { type: "string" },
					"meeting-id": { type: "string" },
					json: { type: "boolean", default: false },
				},
				allowPositionals: false,
			});
			const requestedSessionId = values.session?.trim();
			const meetingId = values["meeting-id"]?.trim();
			if (Boolean(requestedSessionId) === Boolean(meetingId)) {
				throw new Error(
					`${subcommand} requires exactly one of --session or --meeting-id`,
				);
			}
			if (meetingId && !UUID.test(meetingId)) {
				throw new Error("--meeting-id must be a canonical UUID");
			}
			if (subcommand === "status") {
				return finish(
					await request(
						meetingId
							? `/api/voice/sessions/by-meeting/${encodeURIComponent(meetingId)}`
							: `/api/voice/sessions/${encodeURIComponent(requestedSessionId!)}`,
						"GET",
					),
				);
			}
			let sessionId = requestedSessionId;
			if (meetingId) {
				const lookup = await request(
					`/api/voice/sessions/by-meeting/${encodeURIComponent(meetingId)}`,
					"GET",
				);
				const lookupBody = lookup.body as { sessionId?: unknown };
				if (!lookup.response.ok || typeof lookupBody.sessionId !== "string") {
					return finish(lookup);
				}
				sessionId = lookupBody.sessionId;
			}
			return finish(
				await request(
					`/api/voice/sessions/${encodeURIComponent(sessionId!)}/stop`,
					"POST",
				),
			);
		}
		if (subcommand !== "start") {
			throw new Error("start, stop, or status is required");
		}
		const { values } = parseArgs({
			args: args.slice(1),
			options: {
				"meeting-id": { type: "string" },
				"state-dir": { type: "string" },
				mode: { type: "string" },
				project: { type: "string" },
				lead: { type: "string" },
				"evidence-dir": { type: "string" },
				topic: { type: "string" },
				json: { type: "boolean", default: false },
			},
			allowPositionals: false,
		});
		const meetingId = values["meeting-id"]?.trim();
		if (meetingId && !UUID.test(meetingId)) {
			throw new Error("--meeting-id must be a canonical UUID");
		}
		const mode = values.mode?.trim();
		const projectName = values.project?.trim();
		const leadId = values.lead?.trim();
		const evidenceDir = values["evidence-dir"]?.trim();
		const topic = values.topic?.trim();
		const stateDir = values["state-dir"]?.trim();
		const hasTarget = Boolean(
			mode || projectName || leadId || evidenceDir || topic,
		);
		if (Boolean(meetingId) === hasTarget) {
			throw new Error(
				"start requires either --meeting-id or --mode with --project and --lead",
			);
		}
		if (stateDir && !meetingId) {
			throw new Error("--state-dir requires --meeting-id");
		}
		if (stateDir && !isAbsolute(stateDir)) {
			throw new Error("--state-dir must be absolute");
		}
		if (stateDir && stateDir !== canonicalMeetingStateDir(env)) {
			throw new Error("state_dir_drift");
		}
		if (!meetingId) {
			if ((mode !== "meeting" && mode !== "rg") || !projectName || !leadId) {
				throw new Error(
					"--mode meeting|rg, --project, and --lead are required",
				);
			}
			if (mode === "meeting" && !evidenceDir) {
				throw new Error("--evidence-dir is required for meeting mode");
			}
			if (evidenceDir && !isAbsolute(evidenceDir)) {
				throw new Error("--evidence-dir must be absolute");
			}
		}
		return finish(
			await request(
				"/api/voice/sessions",
				"POST",
				meetingId
					? { meetingId }
					: {
							mode,
							projectName,
							leadId,
							...(evidenceDir ? { evidenceDir } : {}),
							...(topic ? { topic } : {}),
						},
			),
		);
	} catch (error) {
		stderr(
			`voice-session: ${requestStarted ? "request failed: " : ""}${error instanceof Error ? error.message : String(error)}`,
		);
		return requestStarted ? 2 : 1;
	}
}
