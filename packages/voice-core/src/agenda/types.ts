/**
 * FLY-2863 voice agenda — the engine-independent contract between the Bridge
 * agenda source, the Lead that digests it, and the mode layer that speaks it.
 *
 * Only four kinds of work reach the founder's ear: what a Lead chose to tell
 * her, an issue waiting for her approval, an issue waiting for her answer, and
 * a blocked issue. Everything else stays in text.
 */

/** Default speaking order (plan §4.1 Q1, founder 2026-09-24 adds 要你答). */
export const AGENDA_CLASSES = [
	"blocked",
	"awaiting_approval",
	"needs_answer",
	"lead_said",
] as const;
export type AgendaClass = (typeof AGENDA_CLASSES)[number];

/** U1: a Lead may flag a main-channel message urgent only with one of these. */
export const AGENDA_LEAD_URGENT_REASONS = [
	"production_down",
	"data_loss_risk",
	"security",
	"deadline_within_1h",
	"founder_requested",
] as const;
export type AgendaLeadUrgentReason =
	(typeof AGENDA_LEAD_URGENT_REASONS)[number];

export type AgendaUrgent =
	| { source: "lead_flag"; reason: AgendaLeadUrgentReason }
	| { source: "priority_urgent_blocked"; reason: "priority_urgent_blocked" };

/** Facts the Bridge attaches for the Lead that digests an item (QA@1 B4):
 * what she is asked, the latest QA verdict, where it is stuck. Read by the
 * Lead, never spoken verbatim, and stripped before a snapshot reaches the
 * voice client. Absent fields are unknown, not empty. */
export interface AgendaItemMaterial {
	/** needs_answer / awaiting_approval: the pending question to her — the
	 * Lead's own thread ask, or the waiting question's text. */
	question?: string;
	/** awaiting_approval / blocked: the latest QA verdict for the issue. */
	qa?: { verdict: "pass" | "fail"; summary: string; reportUrl?: string };
	/** blocked: the phase that stopped and the error it recorded. */
	blocked?: { phase: string; reason: string };
	prNumber?: number;
}

export interface AgendaItem {
	/** Stable per episode: a re-entry into the same class is a new key. */
	itemKey: string;
	class: AgendaClass;
	projectName: string;
	leadId: string;
	/** Spoken name of the Lead that owns the item. */
	leadName: string;
	issueIdentifier: string | null;
	issueTitle: string | null;
	threadUrl: string | null;
	/** When the item entered its class. */
	since: string;
	urgent: AgendaUrgent | null;
	pointers: { messageIds: string[] };
	/** The sourceStatus entry that must be complete to prove this item left. */
	sourceKey: string;
	/** lead_said only: the Lead's own words, for the digesting Lead to read.
	 * Never spoken verbatim. */
	sourceText?: string;
	/** Bridge-side only; see {@link AgendaItemMaterial}. */
	material?: AgendaItemMaterial;
}

export const AGENDA_SOURCE_HEALTH = [
	"complete",
	"partial",
	"unavailable",
	"recovering",
	"source_gap",
] as const;
export type AgendaSourceHealth = (typeof AGENDA_SOURCE_HEALTH)[number];

export interface AgendaSourceStatus {
	status: AgendaSourceHealth;
	asOf: string;
	reason?: string;
}

export interface AgendaSnapshot {
	snapshotId: string;
	asOf: string;
	items: AgendaItem[];
	sourceStatus: Record<string, AgendaSourceStatus>;
	/** True only when every source is complete and fresh (plan §2.1 R1-6). An
	 * item may leave only when this is true or its own source is complete. */
	complete: boolean;
	/** lead_said messages outside the speaking window; a count, never content. */
	olderUnspokenCount: number;
}

export const AGENDA_PURPOSES = [
	"open",
	"item",
	"urgent",
	"resume",
	"checkin",
] as const;
/** Purposes of a server-side agenda brief request. `reply` is a founder turn
 * handed to the Lead through the ordinary user handoff (plan §4.4 R-T5). */
export type AgendaBriefPurpose = (typeof AGENDA_PURPOSES)[number];
export type AgendaPurpose = AgendaBriefPurpose | "reply";

export const AGENDA_DISPOSITIONS = [
	"resolved",
	"decision_recorded",
	"deferred",
] as const;
export type AgendaDisposition = (typeof AGENDA_DISPOSITIONS)[number];

/** One result the Lead wrote for an agenda request or an agenda-bound reply.
 * `lead_reply` is a plain Lead reply on the same request: it may be spoken for
 * the request's own item but never closes anything. */
export type AgendaResult =
	| {
			kind: "lead_reply";
			requestId: string;
			resultEventId: string;
			seq: number;
			text: string;
	  }
	| {
			kind: "say";
			requestId: string;
			resultEventId: string;
			seq: number;
			itemKey: string | null;
			order?: string[];
			text: string;
	  }
	| {
			kind: "close";
			requestId: string;
			resultEventId: string;
			seq: number;
			itemKey: string;
			disposition: AgendaDisposition;
			evidence?: string;
			reason: string;
			/** The line she hears as the item ends (QA@1 B3): the reason is a
			 * record for the ledger and is never spoken. */
			say?: string;
	  };

export interface AgendaItemState {
	item: AgendaItem;
	status: "queued" | "active" | "closed";
	closedAs?: AgendaDisposition | "source_gone";
	enqueuedAt: string;
}

export interface AgendaOutstanding {
	requestId: string;
	purpose: AgendaPurpose;
	/** open/checkin: null; item/resume/urgent: the item; reply: the bound item. */
	itemKey: string | null;
	issuedAt: string;
	rewrites: number;
	/** True once any result for this request has been applied. */
	answered: boolean;
	/** reply only: when the founder turn started (monotonic across restarts),
	 * so a late older turn never supersedes a newer one. */
	turnOrder?: number;
}

/** Durable queue state (plan §4.1 Q8). The Bridge stores it verbatim under a
 * CAS `stateVersion`; session truth stays with VoiceSessionState. */
export interface AgendaState {
	version: 1;
	sessionId: string;
	generation: number;
	stateVersion: number;
	opened: boolean;
	queue: string[];
	active: string | null;
	urgentQueue: string[];
	activeUrgent: string | null;
	items: Record<string, AgendaItemState>;
	outstanding: AgendaOutstanding | null;
	/** requestId → last applied result seq. */
	applied: Record<string, number>;
	lastActivityAt: string;
}

export interface AgendaDispositionRecord {
	itemKey: string;
	disposition: AgendaDisposition;
	evidence: string | null;
	reason: string;
	requestId: string;
	createdAt: string;
}
