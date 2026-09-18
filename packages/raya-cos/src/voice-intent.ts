import type { CoSPorts } from "./ports.js";

export type VoiceIntent = {
	meetingId: string;
	action: "start" | "stop";
};

export type VoiceIntentResult = VoiceIntent &
	(
		| { status: "accepted" }
		| { status: "unavailable"; reason: "voice_transport_not_available" }
	);

export async function requestVoiceIntent(
	intent: VoiceIntent,
	ports: CoSPorts,
): Promise<VoiceIntentResult> {
	return { ...intent, ...(await ports.voiceIntent(intent)) };
}
