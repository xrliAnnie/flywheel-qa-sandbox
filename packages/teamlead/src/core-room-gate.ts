/**
 * FLY-898 — the SINGLE decision that drives fleet-wide core-room reply discipline
 * across BOTH lead backends (Claude plugin `requireMention` + Codex `mention-gate`).
 *
 * A project's "core room" is its `generalChannel` (FLY-173). The Chief of Staff
 * (CoS) is, by the fleet's structural convention, the lead whose own `chatChannel`
 * IS that core channel (core = the CoS's private chat; see reply-guard.ts:29-33).
 * So the CoS naturally hears every core message and needs NO change. FLY-898 only
 * gates the OTHER (non-CoS) leads: in a core room, a non-CoS lead should hear a
 * message only when it is genuinely addressed (a real @ / reply-to-self); a bare
 * no-@ message goes to the CoS alone.
 *
 * `gateNonCoS` is true iff ALL THREE hold — anything else fails OPEN (do not gate,
 * byte-compatible with today):
 *   1. the project HAS a core room (`generalChannel` is a non-empty string), AND
 *   2. the project HAS a CoS (some lead's `chatChannel` === the core channel), AND
 *   3. THIS lead is NOT that CoS (its `chatChannel` !== the core channel).
 *
 * The "core-有-但-无-CoS" case (joycon: a core channel is configured but no lead's
 * chat equals it — a single-lead project) fails condition 2 → `gateNonCoS=false`,
 * so a lone lead is never silenced in its own core (FLY-898 exploration §6.1).
 *
 * Pure + structural (no I/O, no projects.json load) so it can be unit-tested and
 * reused verbatim by the launcher/fleet CLI (`core-room-gate-cli.ts`) and both
 * Codex runtimes — one decision, zero drift.
 */

export interface CoreRoomGateLead {
	agentId: string;
	chatChannel: string;
}

export interface CoreRoomGateProject {
	generalChannel?: string;
	leads: CoreRoomGateLead[];
}

export interface CoreRoomGate {
	/** The project's core channel id, or undefined when it has no core room. */
	coreChannelId?: string;
	/** Whether SOME lead in the project is the CoS (chatChannel === core). */
	projectHasCoS: boolean;
	/** Whether THIS lead is the CoS (chatChannel === core). */
	isCoS: boolean;
	/** The gate decision: silence this non-CoS lead's no-@ core messages. */
	gateNonCoS: boolean;
}

export function resolveCoreRoomGate(
	project: CoreRoomGateProject,
	lead: CoreRoomGateLead,
): CoreRoomGate {
	// An empty string is treated as "no core" (defensive — matches
	// ProjectConfig's non-empty-string validation of generalChannel).
	const coreChannelId =
		project.generalChannel && project.generalChannel.length > 0
			? project.generalChannel
			: undefined;

	if (!coreChannelId) {
		return {
			coreChannelId: undefined,
			projectHasCoS: false,
			isCoS: false,
			gateNonCoS: false,
		};
	}

	const projectHasCoS = (project.leads ?? []).some(
		(l) => l.chatChannel === coreChannelId,
	);
	const isCoS = lead.chatChannel === coreChannelId;
	const gateNonCoS = projectHasCoS && !isCoS;

	return { coreChannelId, projectHasCoS, isCoS, gateNonCoS };
}
