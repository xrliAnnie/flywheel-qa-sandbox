type Role = "user" | "assistant";

interface Turn {
	role: Role;
	createdAt: number;
	done: boolean;
}

/**
 * FLY-2885 T5b: what the v3 data channel says about turns, plus the user
 * turns still waiting for an answer.
 *
 * A pending user turn is cleared only by an assistant turn created after it
 * and done: the old answer's done can arrive after the new user speech (2884
 * s3), so it must not count. The data channel is not a Codex protocol surface;
 * without its assistant events a pending turn simply stays pending and the
 * caller fails honestly.
 *
 * User evidence that trails the latest assistant turn's creation is ignored
 * unless someone spoke since then: transcripts of the answered turn keep
 * landing after the answer started (probe-run2: 7 ms later) and would
 * otherwise leave a phantom pending turn behind.
 */
export class TurnLedger {
	private readonly turns = new Map<string, Turn>();
	private pending: number[] = [];
	private lastAssistantCreatedAt = Number.NEGATIVE_INFINITY;
	private lastSpeakerActiveAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly now: () => number) {}

	created(turnId: string, role: Role): void {
		if (this.turns.has(turnId)) return;
		const createdAt = this.now();
		this.turns.set(turnId, { role, createdAt, done: false });
		if (role === "assistant") this.lastAssistantCreatedAt = createdAt;
	}

	done(turnId: string, role: Role): void {
		const turn = this.turns.get(turnId) ?? {
			role,
			createdAt: this.now(),
			done: false,
		};
		turn.done = true;
		this.turns.set(turnId, turn);
		if (role === "assistant")
			this.pending = this.pending.filter((at) => at >= turn.createdAt);
	}

	/** Someone in the room just passed the uplink gate. */
	speakerActive(): void {
		this.lastSpeakerActiveAt = this.now();
	}

	/** Records user evidence; false when it only trails an answered turn. */
	userEvidence(): boolean {
		const at = this.now();
		if (
			at >= this.lastAssistantCreatedAt &&
			this.lastSpeakerActiveAt < this.lastAssistantCreatedAt
		)
			return false;
		this.pending.push(at);
		return true;
	}

	isDone(turnId: string): boolean {
		return this.turns.get(turnId)?.done === true;
	}

	openAssistantTurn(): boolean {
		for (const turn of this.turns.values())
			if (turn.role === "assistant" && !turn.done) return true;
		return false;
	}

	pendingUserTurn(): boolean {
		return this.pending.length > 0;
	}

	/** The first not-yet-done assistant turn created strictly after `at`. */
	firstAssistantCreatedAfter(at: number): string | undefined {
		let first: { id: string; createdAt: number } | undefined;
		for (const [id, turn] of this.turns) {
			if (turn.role !== "assistant" || turn.done || turn.createdAt <= at)
				continue;
			if (!first || turn.createdAt < first.createdAt)
				first = { id, createdAt: turn.createdAt };
		}
		return first?.id;
	}

	reset(): void {
		this.turns.clear();
		this.pending = [];
		this.lastAssistantCreatedAt = Number.NEGATIVE_INFINITY;
		this.lastSpeakerActiveAt = Number.NEGATIVE_INFINITY;
	}
}
