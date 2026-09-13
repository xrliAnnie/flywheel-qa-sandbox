import { createHash } from "node:crypto";
import { parseMigrationCutoffs } from "./lead-backend-migration-cutoff.js";
import type { MigrationOperatorArtifact } from "./lead-backend-migration-operator.js";
import type { MailboxQueue } from "./mailbox-queue.js";
import { encodeSenderRef } from "./sender-ref.js";

/** Durable delivery handoff only; mailbox acknowledgement never proves business completion. */
export function enqueueMigrationHandoff(
	queue: MailboxQueue,
	artifact: MigrationOperatorArtifact,
	identity: { botUserId: string; channelIds: string[] },
	assertWindowAndStopped: () => void,
): string[] {
	assertWindowAndStopped();
	if (artifact.version !== 1 || !/^[a-f0-9]{64}$/.test(artifact.intentSha))
		throw new Error("invalid migration handoff intent");
	const cutoffs = parseMigrationCutoffs(artifact.cutoffs, identity);
	const artifactSha = createHash("sha256")
		.update(
			JSON.stringify({ version: 1, intentSha: artifact.intentSha, cutoffs }),
		)
		.digest("hex");
	const ids: string[] = [];
	for (const channel of cutoffs.channels) {
		if (
			!channel.unresolvedMessageIds.length &&
			channel.unresolvedBefore === null
		)
			continue;
		assertWindowAndStopped();
		const id = `migration:FLY-2459:${artifact.intentSha}:${channel.channelId}`;
		const result = queue.enqueue({
			id,
			fromAgent: "flywheel-backend-migration",
			toAgent: "flywheel-product-lead",
			recipientKind: "lead",
			type: "notification",
			msgClass: "model",
			sourceKind: "migration",
			sourceRef: artifactSha,
			createdAt: cutoffs.writerStoppedAt,
			senderRef: encodeSenderRef(),
			content: [
				"FLY-2459 backend migration: unresolved Discord history handoff.",
				"Read these messages and the history older than unresolvedBefore (exclusive), when present. Before repeating any action, reconcile existing issues, runs, and other side effects; missing bot replies do not prove no action occurred.",
				"This handoff grants no restart, dispatch, or approval authority. Follow current department scope and existing gates. Mailbox delivery or ACK is not evidence that this work is complete.",
				JSON.stringify({
					intentSha: artifact.intentSha,
					artifactSha,
					botUserId: cutoffs.botUserId,
					...channel,
				}),
			].join("\n"),
		});
		if (result.outcome !== "archived" && result.row.state === "DEAD")
			throw new Error("migration handoff delivery is dead");
		if (result.outcome === "archived") {
			const delivered = queue.getArchivedFamilySnapshots(id).some((json) => {
				const row = JSON.parse(json);
				return row.id === id && row.state === "ACKED";
			});
			if (!delivered) throw new Error("migration handoff delivery is unproven");
		}
		ids.push(id);
	}
	return ids;
}
