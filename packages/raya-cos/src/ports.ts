export type LeadRef = {
	project: string;
	leadId: string;
};

export type RequestKey = {
	requestId: string;
	revision: number;
};

export type LeadTransportUnavailable = {
	status: "unavailable";
	reason: "lead_transport_not_available";
};

export type QueueReceipt =
	| LeadTransportUnavailable
	| {
			requestId: string;
			deliveryId: string;
			recipient: LeadRef;
			status: "queued" | "already_queued";
	  };

export type AnnouncementReceipt =
	| {
			status: "sent" | "pending" | "ambiguous";
			messageId?: string;
	  }
	| {
			status: "unavailable";
			reason: "announcement_transport_not_available";
	  };

export type VoiceIntentReceipt =
	| { status: "accepted" }
	| { status: "unavailable"; reason: "voice_transport_not_available" };

export type CoSLead = {
	ref: LeadRef;
	botUserId: string;
	displayName: string;
	aliases: readonly string[];
	projectRoot: string;
	identityPath?: string;
	memoryPaths: readonly string[];
	writableRoots: readonly string[];
	voice?: string | { voiceId: string; rate?: string; pitch?: string };
};

export interface CoSPorts {
	directory(): Promise<{
		projectsDigest: string;
		leads: readonly CoSLead[];
	}>;
	request(input: {
		key: RequestKey;
		to: LeadRef;
		kind: "question" | "meeting";
		correlation: string;
		body: string;
		expiresAt: number;
	}): Promise<QueueReceipt>;
	reply(input: { key: RequestKey; body: string }): Promise<QueueReceipt>;
	announce(input: {
		eventId: string;
		target: "chat" | "roundtable";
		text: string;
	}): Promise<AnnouncementReceipt>;
	voiceIntent(input: {
		meetingId: string;
		action: "start" | "stop";
	}): Promise<VoiceIntentReceipt>;
}

export function createUnavailablePorts(): CoSPorts {
	return {
		async directory() {
			return { projectsDigest: "unavailable", leads: [] };
		},
		async request() {
			return {
				status: "unavailable",
				reason: "lead_transport_not_available",
			};
		},
		async reply() {
			return {
				status: "unavailable",
				reason: "lead_transport_not_available",
			};
		},
		async announce() {
			return {
				status: "unavailable",
				reason: "announcement_transport_not_available",
			};
		},
		async voiceIntent() {
			return {
				status: "unavailable",
				reason: "voice_transport_not_available",
			};
		},
	};
}
