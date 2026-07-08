/**
 * VoiceDirectory — agentId → VoiceSpec mapping for per-agent voices
 * (FLY-546 A2, PRD §17 "换 agent 换声线"). Unknown agents resolve to the
 * fallback voice so headphone mode never fails on an unmapped Lead.
 */
import { VoiceError, type VoiceSpec } from "../types.js";

export class VoiceDirectory {
	private readonly map = new Map<string, VoiceSpec>();

	constructor(
		entries: Record<string, VoiceSpec>,
		private readonly fallback: VoiceSpec,
	) {
		for (const [agentId, spec] of Object.entries(entries)) {
			const key = agentId.toLowerCase();
			if (this.map.has(key)) {
				throw new VoiceError(
					"component-missing",
					`VoiceDirectory: duplicate agentId "${agentId}" (case-insensitive) — fix the voice config`,
				);
			}
			this.map.set(key, spec);
		}
	}

	resolve(agentId: string): VoiceSpec {
		return this.map.get(agentId.toLowerCase()) ?? this.fallback;
	}
}
