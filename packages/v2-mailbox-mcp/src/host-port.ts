/**
 * FLY-1547: the production HostPort — a thin adapter over the authenticated
 * v2 host socket (V2Client).
 *
 * R3-F4 (generation safety): the lead credential is loaded ONCE at startup
 * and cached for this child's lifetime. A takeover rewrites the file for the
 * NEW lead session's child; this child keeps presenting its own (now revoked)
 * bearer, gets the host's loud fence refusal on the next call, and its bell
 * failure counter fail-stops the process. Re-reading the shared file per call
 * would instead let the superseded child silently ADOPT the replacement
 * generation's bearer — the exact hole this cache closes.
 */
import { readFileSync } from "node:fs";
import type { V2Client } from "flywheel-v2-cli";
import type { MailboxIdentity } from "./identity.js";
import type {
	DeliveryEnvelopeLike,
	HostPort,
	MailboxStatusShape,
} from "./service.js";

function readCredential(file: string): { credentialId: string; token: string } {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { credentialId?: unknown }).credentialId !== "string" ||
		typeof (parsed as { token?: unknown }).token !== "string"
	) {
		throw new Error(`lead delivery credential at ${file} has an invalid shape`);
	}
	return parsed as { credentialId: string; token: string };
}

export function createHostPort(
	client: V2Client,
	identity: MailboxIdentity,
): HostPort {
	// Load-once (R3-F4): startup fails loud if the file is absent/invalid.
	const cachedCredential =
		identity.mode === "lead"
			? readCredential(identity.credentialFile)
			: undefined;
	const nextPayload = () =>
		identity.mode === "runner"
			? { sessionRef: identity.sessionRef }
			: {
					agentId: identity.agentId,
					deliveryCredential: cachedCredential,
				};
	return {
		async next() {
			try {
				return await client.request<DeliveryEnvelopeLike>(
					"next_delivery",
					nextPayload(),
				);
			} catch (error) {
				if (
					error instanceof Error &&
					/no delivery became available/.test(error.message)
				) {
					return "empty";
				}
				throw error;
			}
		},
		async submit(input) {
			return client.submitProposalWithRetry(input);
		},
		async enqueue(input) {
			return client.request("enqueue", input);
		},
		async ask(input) {
			if (identity.mode !== "runner") {
				throw new Error(
					"ask is the runner→lead verb; a lead answers with settle({reply})",
				);
			}
			return client.request("ask", {
				sessionRef: identity.sessionRef,
				askKind: input.askKind,
				payload: input.payload,
			});
		},
		async mailboxStatus() {
			return client.request<MailboxStatusShape>(
				"mailbox_status",
				nextPayload(),
			);
		},
		selfId: () =>
			identity.mode === "runner" ? identity.sessionRef : identity.agentId,
	};
}
