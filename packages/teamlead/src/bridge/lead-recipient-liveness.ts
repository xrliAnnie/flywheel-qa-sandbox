import type { LeadLeaseRow, ProcessTupleState } from "flywheel-comm/lead-lease";
import type { MailboxRecipientState } from "flywheel-comm/mailbox-queue";

export interface LeadLeaseReader {
	getLease(leadKey: string): LeadLeaseRow | undefined;
	close?: () => void;
}

export function readLeadRecipientState(input: {
	leadKey: string;
	leaseReader: Pick<LeadLeaseReader, "getLease">;
	processTupleState: (pid: number, start: string) => ProcessTupleState;
}): MailboxRecipientState {
	let lease: LeadLeaseRow | undefined;
	try {
		lease = input.leaseReader.getLease(input.leadKey);
	} catch {
		return "alive";
	}
	if (
		!lease ||
		lease.leadKey !== input.leadKey ||
		!lease.identityDigest?.trim() ||
		!lease.boundAt ||
		!Number.isSafeInteger(lease.holderPid) ||
		(lease.holderPid ?? 0) <= 0 ||
		!lease.holderStart?.trim()
	) {
		return "alive";
	}
	return input.processTupleState(lease.holderPid!, lease.holderStart) ===
		"alive"
		? "alive"
		: "unknown";
}
