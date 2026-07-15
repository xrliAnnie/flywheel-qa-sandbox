/**
 * AddressRouter (FLY-545 PR-2 P10′) — the huddle's sticky addressing pointer.
 *
 * FLY-968 killed all-listen (un-addressed sessions answer over each other,
 * 8/10 rounds), so the founder's audio feeds exactly ONE Gemini session — the
 * addressed Lead's. The pointer is sticky: it starts on the host (the first
 * @-mentioned Lead, PRD R9) and only moves when a FINAL founder transcript
 * explicitly names another participant. The switching utterance itself was
 * heard by the OLD session (chicken-and-egg of name detection), so the
 * orchestrator handles the handoff: interrupt the old session, replay the
 * transcript as a speech-triggering text turn into the new one.
 *
 * Mis-detection is cheap by design: a false hit means the wrong Lead answers
 * one round and Annie corrects out loud; a miss means the old Lead answers.
 * Neither loses transcript. Aliases are matched case-insensitively; the LAST
 * name mentioned in the utterance wins ("Tadashi 说的对,Hiro 你觉得呢?" →
 * Hiro).
 */

export interface AddressParticipant {
	leadId: string;
	/** names that count as addressing this Lead: Discord display name +
	 * config extras. Matched case-insensitive, substring (Chinese transcripts
	 * carry no word boundaries). Aliases shorter than 2 chars are ignored. */
	aliases: string[];
}

export interface RouteResult {
	/** the Lead whose session should receive founder audio going forward. */
	addressed: string;
	/** true when this utterance moved the pointer (handoff round). */
	switched: boolean;
	switchedFrom?: string;
}

const MIN_ALIAS_LEN = 2;

export class AddressRouter {
	private current: string;
	private readonly participants: Map<string, string[]>;

	constructor(participants: AddressParticipant[], hostLeadId: string) {
		if (!participants.some((p) => p.leadId === hostLeadId)) {
			throw new Error(
				`AddressRouter: host "${hostLeadId}" is not among the participants`,
			);
		}
		this.participants = new Map(
			participants.map((p) => [
				p.leadId,
				p.aliases
					.filter((a) => a.trim().length >= MIN_ALIAS_LEN)
					.map((a) => a.trim().toLowerCase()),
			]),
		);
		this.current = hostLeadId;
	}

	get addressed(): string {
		return this.current;
	}

	/** force the pointer to a specific participant (QA R5 / Codex R36
	 * HIGH-2): the addressed line's connection died for good — her audio
	 * must not keep feeding a dead session, and a name-based switch can't
	 * happen because the dead line would have to transcribe it. */
	forceSwitch(leadId: string): RouteResult {
		if (!this.participants.has(leadId) || leadId === this.current) {
			return { addressed: this.current, switched: false };
		}
		const from = this.current;
		this.current = leadId;
		return { addressed: leadId, switched: true, switchedFrom: from };
	}

	/** scan a FINAL founder transcript for an explicit switch of addressee. */
	route(finalTranscript: string): RouteResult {
		const text = finalTranscript.toLowerCase();
		let winner: string | undefined;
		let winnerPos = -1;
		for (const [leadId, aliases] of this.participants) {
			for (const alias of aliases) {
				const pos = text.lastIndexOf(alias);
				if (pos > winnerPos) {
					winnerPos = pos;
					winner = leadId;
				}
			}
		}
		if (winner === undefined || winner === this.current) {
			return { addressed: this.current, switched: false };
		}
		const from = this.current;
		this.current = winner;
		return { addressed: winner, switched: true, switchedFrom: from };
	}
}
