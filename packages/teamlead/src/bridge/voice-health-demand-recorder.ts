import { type ChildProcess, execFile } from "node:child_process";
import type {
	VoiceHealthDemandEvent,
	VoiceHealthDemandSnapshot,
} from "../StateStore.js";

const MAX_INPUT_BYTES = 32 * 1024;
const ACCEPTED_RECEIPTS = new Set([
	"recorded",
	"existing",
	"refreshed",
	"stale",
]);

interface ExecOptions {
	encoding: "utf8";
	maxBuffer: number;
	shell: false;
	timeout: number;
	windowsHide: true;
}

export type VoiceHealthDemandExecFile = (
	file: string,
	args: string[],
	options: ExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;

function demandEvent(event: VoiceHealthDemandEvent): Record<string, unknown> {
	return {
		eventSeq: event.eventSeq,
		eventKind: event.eventKind,
		demandId: event.demandId,
		attemptId: event.attemptId,
		observedAt: event.observedAt,
		...(event.eventKind === "failed"
			? { reasonClass: event.reasonClass ?? "unknown_failure" }
			: {}),
	};
}

export function voiceHealthDemandPayload(
	snapshot: VoiceHealthDemandSnapshot,
	refreshObservedAt: boolean,
): Record<string, unknown> {
	// FLY-2693 review R5 (fail-closed-demand-never-reaches-helper): degraded
	// StateStore authority (trigger_invalid / change_gap / demand_overflow) is
	// projected through as an explicit sourceStatus so the helper publishes
	// unknown/unavailable. It carries no page: the cursor is not consumed.
	if (snapshot.sourceStatus !== "available") {
		return {
			demandSourceId: snapshot.demandSourceId,
			revision: snapshot.revision,
			digest: snapshot.digest,
			state: "unknown",
			observedAt: snapshot.observedAt,
			identities: [],
			refreshObservedAt,
			sourceStatus: snapshot.sourceStatus,
		};
	}
	return {
		demandSourceId: snapshot.demandSourceId,
		revision: snapshot.revision,
		digest: snapshot.digest,
		state: snapshot.state,
		observedAt: snapshot.observedAt,
		identities: snapshot.demandIdentities,
		refreshObservedAt,
		sourceStatus: "available",
		pageAfterCursor: snapshot.afterCursor,
		pageNextCursor: snapshot.nextCursor,
		eventHighWater: snapshot.eventHighWater,
		hasMore: snapshot.hasMore,
		gap: snapshot.gap,
		events: snapshot.events.map(demandEvent),
	};
}

export function createVoiceHealthDemandRecorder(input: {
	helperPath: string;
	stateRoot: string;
	execFile?: VoiceHealthDemandExecFile;
	refreshObservedAt?: () => boolean;
}): (snapshot: VoiceHealthDemandSnapshot) => Promise<void> {
	const run = input.execFile ?? execFile;
	return async (snapshot) => {
		let encoded: string;
		try {
			encoded = JSON.stringify(
				voiceHealthDemandPayload(
					snapshot,
					input.refreshObservedAt?.() ??
						(snapshot.events.length === 0 && !snapshot.hasMore),
				),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "voice_demand_source_unavailable"
			)
				throw error;
			throw new Error("voice_health_helper_unavailable");
		}
		if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES)
			throw new Error("voice_health_helper_unavailable");
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = () => {
				if (settled) return;
				settled = true;
				reject(new Error("voice_health_helper_unavailable"));
			};
			let child: ChildProcess;
			try {
				child = run(
					"python3",
					[input.helperPath, "--state-root", input.stateRoot, "record-demand"],
					{
						encoding: "utf8",
						maxBuffer: 65_536,
						shell: false,
						timeout: 500,
						windowsHide: true,
					},
					(error, stdout) => {
						if (error) return fail();
						try {
							const receipt = JSON.parse(stdout) as unknown;
							if (
								!receipt ||
								typeof receipt !== "object" ||
								Array.isArray(receipt) ||
								!ACCEPTED_RECEIPTS.has(
									String((receipt as Record<string, unknown>).status),
								)
							)
								return fail();
							settled = true;
							resolve();
						} catch {
							fail();
						}
					},
				);
			} catch {
				return fail();
			}
			if (!child.stdin) return fail();
			child.stdin.once("error", fail);
			child.stdin.end(encoded, "utf8");
		});
	};
}
