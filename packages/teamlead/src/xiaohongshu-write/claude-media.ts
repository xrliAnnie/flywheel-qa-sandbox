import type { Readable } from "node:stream";
import { createClaudeXhsBridgeClient } from "./claude-bridge-client.js";
import { artifactSchema } from "./contracts.js";

/** Caller supplies an already-open binary stream. Never opens a path or URL. */
export async function importClaudeXhsMedia(
	input: Readable,
	mime: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
) {
	const stopped = signal
		? AbortSignal.any([signal, AbortSignal.timeout(180000)])
		: AbortSignal.timeout(180000);
	const abort = () => input.destroy(Error("xhs_request_invalid"));
	stopped.addEventListener("abort", abort, { once: true });
	let phase: "input" | "upload" = "input";
	try {
		stopped.throwIfAborted();
		const mimeType = artifactSchema.shape.mimeType.parse(mime);
		const client = createClaudeXhsBridgeClient(env);
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of input) {
			stopped.throwIfAborted();
			if (!(chunk instanceof Uint8Array)) throw Error();
			size += chunk.byteLength;
			if (size > 10 * 1024 * 1024) throw Error();
			chunks.push(Buffer.from(chunk));
		}
		if (!size) throw Error();
		stopped.throwIfAborted();
		phase = "upload";
		return await client.importArtifact(
			Buffer.concat(chunks, size),
			mimeType,
			stopped,
		);
	} catch (error) {
		input.destroy();
		if (error instanceof Error && error.message === "founder_write_gate_absent")
			throw Error(error.message);
		throw Error(
			phase === "input" ? "xhs_request_invalid" : "xhs_result_unknown",
		);
	} finally {
		stopped.removeEventListener("abort", abort);
	}
}
