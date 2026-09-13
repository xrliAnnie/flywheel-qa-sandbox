import { enqueueMigrationHandoff } from "flywheel-comm/lead-backend-migration-handoff";
import type { MigrationOperatorArtifact } from "flywheel-comm/lead-backend-migration-operator";
import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import {
	type CursorSeedResult,
	seedLeadInboundCursor,
} from "./seed-lead-inbound-cursor.js";

/** Internal FLY-2459 adapter under the authorized restart window, per Lead ruling c83ad949. */
export function seedBackendMigration(input: {
	path: string;
	expectedBeforeSha256: string | null;
	artifact: MigrationOperatorArtifact;
	identity: { botUserId: string; channelIds: string[] };
	queue: MailboxQueue;
	assertWindowAndStopped(): void;
}): { handoffIds: string[]; cursor: CursorSeedResult } {
	// Persist every unresolved ID/range before advancing the transport cutoff.
	// On partial failure, the standard mailbox's stable identities make retries safe.
	const handoffIds = enqueueMigrationHandoff(
		input.queue,
		input.artifact,
		input.identity,
		input.assertWindowAndStopped,
	);
	input.assertWindowAndStopped();
	const channels = input.artifact.cutoffs.channels;
	const cursor = seedLeadInboundCursor({
		path: input.path,
		seed: {
			schemaVersion: 1,
			migrationId: input.artifact.cutoffs.migrationId,
			expectedBeforeSha256: input.expectedBeforeSha256,
			writerStopped: true,
			// Unresolved work was durably handed off above, not declared complete.
			// The generic seeder's default unresolved refusal remains unchanged.
			unresolved: [],
			channels: channels.flatMap((channel) =>
				channel.cutoffId === null
					? []
					: [
							{
								channelId: channel.channelId,
								lastConfirmedMessageId: channel.cutoffId,
							},
						],
			),
			emptyChannels: channels
				.filter((channel) => channel.cutoffId === null)
				.map((channel) => channel.channelId),
		},
	});
	return { handoffIds, cursor };
}
