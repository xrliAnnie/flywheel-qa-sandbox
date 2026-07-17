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
