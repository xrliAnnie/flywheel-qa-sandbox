import type { ExecutionBodyLivenessReader } from "./execution-body-reader.js";

export type StartedEvidence =
	| { started: true; tmuxWindow?: string }
	| {
			started: false;
			/** Legacy producer values are recognized only to refuse replay authority. */
			reason:
				| "body_dead"
				| "no_row"
				| "pending_only"
				| "tmux_dead"
				| "lookup_error";
	  };

export interface StartedEvidenceDeps {
	readBodyLiveness?: ExecutionBodyLivenessReader;
}

/** Only the shared reader can prove a current live body or settled death.
 * Missing metadata, a window, and an early session row are not process evidence.
 * Unknown refuses replay so an unavailable observer cannot start a second body. */
export async function checkStartedEvidence(
	executionId: string,
	projectName: string,
	deps: StartedEvidenceDeps = {},
): Promise<StartedEvidence> {
	try {
		const verdict = deps.readBodyLiveness?.(executionId, projectName);
		if (verdict === "alive") return { started: true };
		if (verdict === "dead") return { started: false, reason: "body_dead" };
	} catch {
		// An unavailable observer cannot authorize delivery repair.
	}
	return { started: false, reason: "lookup_error" };
}

/** Gateway reads a coarse verdict from Bridge's existing authenticated query.
 * This DTO is a replay check, never accepted as mutation/CAS authority. Bridge
 * independently revalidates its own current observation on the action path. */
export async function readStartedEvidenceFromBridge(
	executionId: string,
	projectName: string,
	options: { bridgeUrl: string; apiToken: string; fetchImpl?: typeof fetch },
): Promise<StartedEvidence> {
	const unknown: StartedEvidence = { started: false, reason: "lookup_error" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await (options.fetchImpl ?? fetch)(
			`${options.bridgeUrl.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(executionId)}`,
			{
				headers: { Authorization: `Bearer ${options.apiToken}` },
				signal: controller.signal,
				redirect: "error",
			},
		);
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return unknown;
		}
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 65_536) return unknown;
			chunks.push(chunk.value);
		}
		if (controller.signal.aborted) return unknown;
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (
			!body ||
			typeof body !== "object" ||
			!("execution_id" in body) ||
			body.execution_id !== executionId ||
			!("project_name" in body) ||
			body.project_name !== projectName ||
			!("body_verdict" in body)
		)
			return unknown;
		const verdict = body.body_verdict;
		return checkStartedEvidence(executionId, projectName, {
			readBodyLiveness: () =>
				verdict === "alive" || verdict === "dead" ? verdict : "unknown",
		});
	} catch {
		return unknown;
	} finally {
		controller.abort();
		clearTimeout(timer);
		await reader?.cancel().catch(() => {});
	}
}
