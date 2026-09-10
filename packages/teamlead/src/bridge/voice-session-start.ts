import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
	canonicalizeMeetingStateDir,
	loadMeetingNotesConfig,
	loadTrustedCurrentMeeting,
} from "../meeting-notes-config.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadByAgentIdAcrossRegistry } from "../ProjectConfig.js";
import type {
	VoiceCredentialTier,
	VoiceSessionMode,
	VoiceSessionReservation,
} from "../StateStore.js";
import type { VoiceHostConfig } from "../voice-host-config.js";
import { VoiceSessionHttpError } from "./voice-session-routes.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VoiceStartPreflightInput {
	mode: VoiceSessionMode;
	project: ProjectEntry;
	lead: LeadConfig;
	voiceHost: VoiceHostConfig;
	voiceBotToken: string;
	earsBotToken: string;
	evidenceDir?: string;
	topic?: string;
}

export interface VoiceStartResolverDeps {
	projects: ProjectEntry[];
	voiceHost: VoiceHostConfig;
	meetingConfigPath: string;
	env?: Readonly<Record<string, string | undefined>>;
	preflight: (input: VoiceStartPreflightInput) => void | Promise<void>;
	newSessionId: () => string;
	now?: () => string;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return value.trim();
}

function canonicalEvidenceDir(path: string, roots: readonly string[]): string {
	try {
		if (!isAbsolute(path)) throw new Error("not absolute");
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error("not directory");
		const canonical = realpathSync(path);
		const allowed = roots.some((root) => {
			const canonicalRoot = realpathSync(root);
			const rel = relative(canonicalRoot, canonical);
			return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
		});
		if (!allowed) throw new Error("outside root");
		return canonical;
	} catch {
		throw new VoiceSessionHttpError(400, "evidence_dir_rejected");
	}
}

function projectLead(
	projects: ProjectEntry[],
	projectName: string,
	leadId: string,
): { project: ProjectEntry; lead: LeadConfig } {
	const project = projects.find(
		(candidate) => candidate.projectName === projectName,
	);
	const lead = project?.leads.find((candidate) => candidate.agentId === leadId);
	if (!project || !lead) throw new VoiceSessionHttpError(404, "lead_not_found");
	return { project, lead };
}

function modeEnabled(lead: LeadConfig, mode: VoiceSessionMode): void {
	if (
		mode === "meeting"
			? lead.voiceModes?.meeting === false
			: lead.voiceModes?.rg !== true
	) {
		throw new VoiceSessionHttpError(403, "voice_mode_not_enabled");
	}
}

function huddleCredentials(
	project: ProjectEntry,
	lead: LeadConfig,
	env: Readonly<Record<string, string | undefined>>,
): { voiceBotToken: string; earsBotToken: string } {
	const huddle = project.huddle;
	if (!huddle?.orchestratorBotUserId) {
		throw new VoiceSessionHttpError(503, "voice_unavailable", "huddle_missing");
	}
	const voiceBotToken = env[huddle.orchestratorBotTokenEnv]?.trim();
	const earsBotToken = env[huddle.earsBotTokenEnv]?.trim();
	if (!voiceBotToken || !earsBotToken || !lead.botToken || !lead.botUserId) {
		throw new VoiceSessionHttpError(503, "voice_unavailable", "bot_env_unset");
	}
	return { voiceBotToken, earsBotToken };
}

export function createVoiceStartResolver(
	deps: VoiceStartResolverDeps,
): (
	body: unknown,
	credentialTier: VoiceCredentialTier,
) => Promise<VoiceSessionReservation> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? (() => new Date().toISOString());
	return async (body, credentialTier) => {
		const request = object(body);
		let mode: VoiceSessionMode;
		let project: ProjectEntry;
		let lead: LeadConfig;
		let meetingId: string | undefined;
		let evidenceDir: string | undefined;
		let topic: string | undefined;

		if ("meetingId" in request) {
			exactKeys(request, ["meetingId", "requestedBy"]);
			meetingId = requiredString(request.meetingId);
			if (!UUID.test(meetingId)) {
				throw new VoiceSessionHttpError(400, "voice_request_invalid");
			}
			let meeting: ReturnType<typeof loadTrustedCurrentMeeting>;
			try {
				const config = loadMeetingNotesConfig(deps.meetingConfigPath);
				evidenceDir = canonicalizeMeetingStateDir(config);
				meeting = loadTrustedCurrentMeeting(config);
			} catch {
				throw new VoiceSessionHttpError(400, "meeting_invalid");
			}
			if (
				!meeting ||
				meeting.id !== meetingId ||
				!new Set(["starting", "live", "interrupted"]).has(meeting.status) ||
				meeting.voice?.state === "ended"
			) {
				throw new VoiceSessionHttpError(400, "meeting_invalid");
			}
			try {
				const resolved = resolveLeadByAgentIdAcrossRegistry(
					deps.projects,
					meeting.leadId,
				);
				if (!resolved) throw new VoiceSessionHttpError(404, "lead_not_found");
				({ project, lead } = resolved);
			} catch (error) {
				if (error instanceof VoiceSessionHttpError) throw error;
				throw new VoiceSessionHttpError(400, "lead_ambiguous");
			}
			mode = "meeting";
			topic = meeting.topic;
		} else {
			exactKeys(request, [
				"mode",
				"projectName",
				"leadId",
				"evidenceDir",
				"topic",
				"requestedBy",
			]);
			if (request.mode !== "meeting" && request.mode !== "rg") {
				throw new VoiceSessionHttpError(400, "voice_request_invalid");
			}
			mode = request.mode;
			({ project, lead } = projectLead(
				deps.projects,
				requiredString(request.projectName),
				requiredString(request.leadId),
			));
			if (request.evidenceDir !== undefined) {
				evidenceDir = requiredString(request.evidenceDir);
			}
			if (request.topic !== undefined) topic = requiredString(request.topic);
		}

		modeEnabled(lead, mode);
		const credentials = huddleCredentials(project, lead, env);
		if (mode === "meeting" && !evidenceDir) {
			throw new VoiceSessionHttpError(400, "evidence_dir_rejected");
		}
		if (evidenceDir) {
			evidenceDir = canonicalEvidenceDir(
				evidenceDir,
				deps.voiceHost.evidenceRoots,
			);
		}
		await deps.preflight({
			mode,
			project,
			lead,
			voiceHost: deps.voiceHost,
			...credentials,
			...(evidenceDir ? { evidenceDir } : {}),
			...(topic ? { topic } : {}),
		});
		return {
			sessionId: deps.newSessionId(),
			mode,
			projectName: project.projectName,
			leadId: lead.agentId,
			guildId: project.huddle!.guildId,
			voiceChannelId: project.huddle!.voiceChannelId,
			...(meetingId ? { meetingId } : {}),
			...(evidenceDir ? { evidenceDir } : {}),
			...(topic ? { topic } : {}),
			requestedBy: credentialTier,
			credentialTier,
			createdAt: now(),
		};
	};
}
