/**
 * Build the config object passed directly to runVoiceBridge by staged rigs.
 * The executable scripts validate required env values before calling this.
 */
export function buildStagedConfig(env) {
	return {
		projectName: env.STAGED_PROJECT_NAME ?? "flywheel",
		projectRoot: process.cwd(),
		guildId: env.STAGED_GUILD_ID,
		voiceChannelId: env.STAGED_VC_ID,
		commandName: "meet",
		moveMembers: false,
		orchestratorToken: env.HUDDLE_ORCH_BOT_TOKEN,
		earsToken: env.HUDDLE_EARS_BOT_TOKEN,
		leads: [],
		bridgeUrl: env.FLYWHEEL_BRIDGE_URL,
		apiToken: env.FLYWHEEL_API_TOKEN,
		founderUserId: env.DISCORD_OWNER_USER_ID ?? "",
		geminiApiKey: env.GEMINI_API_KEY,
		// Keep staged rigs aligned with the loader's production model default.
		geminiModel:
			env.FLYWHEEL_HUDDLE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview",
		backchannelMs: 350,
		// Measurement-rig override, not loader parity: keep the synthetic probe
		// out of the RMS noise gate (the production loader default is 700).
		bargeInMinRms: 0,
		bargeInHoldoffMs: 1_000,
		allowUserIds: [],
		healthPort: Number(env.STAGED_HEALTH_PORT ?? 9_879),
		ffmpegBin: env.FFMPEG_BIN ?? "ffmpeg",
	};
}

/**
 * Resident leases need a durable Lead owner plus the human identity used by
 * the room self-filter. The output and ears bot ids are intentionally not
 * accepted here: runVoiceBridge derives both from the authenticated clients,
 * so a staged rig cannot accidentally assert made-up Discord identities.
 */
export function buildStagedResidentIdentity(env, founderUserId) {
	const founder = String(founderUserId ?? "").trim();
	if (!founder) throw new Error("staged founder identity is required");
	const leadId = String(env.STAGED_LEAD_ID ?? "flywheel-eng-lead").trim();
	if (!leadId) throw new Error("staged Lead identity is required");
	return { leadId, founderUserId: founder };
}
