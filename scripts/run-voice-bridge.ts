#!/usr/bin/env npx tsx

/**
 * voice-bridge daemon entry point (FLY-545).
 *
 * A STANDALONE launchd daemon (com.flywheel.voice-bridge) — deliberately NOT
 * part of the Bridge process: the realtime audio loop must not be blocked by
 * Bridge event handling, and the (unofficial) voice-receive leg must not take
 * the Bridge down with it when it breaks.
 *
 * Usage:
 *   npx tsx scripts/run-voice-bridge.ts
 *
 * Environment (sourced from ~/.flywheel/.env by the wrapper):
 *   - the huddle block's orchestratorBotTokenEnv / earsBotTokenEnv vars
 *   - each participating lead's botTokenEnv var
 *   - GEMINI_API_KEY (PR-2 conversation loop; PR-1 warns if unset)
 *   - FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT (default 9878)
 */

import { main } from "../packages/voice-bridge/dist/cli.js";

main().catch((err) => {
	console.error("[voice-bridge] fatal:", err);
	process.exit(1);
});
