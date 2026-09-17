import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { artifactSchema, type FrozenArtifact } from "./contracts.js";
import type {
	createWriteIngressHandler,
	WriteIngressContext,
} from "./ingress.js";
import { createNativePeerReader } from "./native-peer.js";

const id = z.string().min(1).max(256);
export const artifactImportMetadata = z
	.object({
		projectId: id,
		leadId: id,
		activationId: id,
		mimeType: artifactSchema.shape.mimeType,
		sizeBytes: z
			.number()
			.int()
			.positive()
			.max(10 * 1024 * 1024),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
/** Separate bounded binary endpoint. Metadata selects only root-registered scope;
 * bytes become a new authority-owned artifact, never a caller-supplied path. */
export function createArtifactIngressHandler(options: {
	modelUid: number;
	peerHelper: { path: string; sha256: string };
	scope: Parameters<typeof createWriteIngressHandler>[0]["scope"];
	import: (
		context: WriteIngressContext,
		mime: FrozenArtifact["mimeType"],
		stream: AsyncIterable<Uint8Array>,
		signal: AbortSignal,
	) => Promise<FrozenArtifact>;
}) {
	const peer = createNativePeerReader(options.peerHelper);
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		const timer = setTimeout(() => {
			abort();
			req.destroy();
			res.destroy();
		}, 180000);
		const check = () => {
			controller.signal.throwIfAborted();
			if (req.socket.destroyed) throw Error();
		};
		try {
			const uid = await peer(req.socket, controller.signal);
			check();
			if (
				uid !== options.modelUid ||
				req.method !== "POST" ||
				req.url !== "/v1/artifact/import" ||
				req.headers["content-type"] !== "application/octet-stream"
			)
				throw Error();
			const header = req.headers["x-flywheel-artifact"];
			if (typeof header !== "string" || header.length > 4096) throw Error();
			const bytes = Buffer.from(header, "base64");
			if (bytes.toString("base64") !== header) throw Error();
			const metadata = artifactImportMetadata.parse(
				parseStrictJson(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				),
			);
			const context = structuredClone(
				await options.scope(
					uid,
					{
						projectId: metadata.projectId,
						leadId: metadata.leadId,
						activationId: metadata.activationId,
					},
					controller.signal,
					"write",
				),
			);
			check();
			if (
				!context ||
				context.identity.requesterUid !== uid ||
				context.identity.projectId !== metadata.projectId ||
				context.identity.leadId !== metadata.leadId ||
				context.activationId !== metadata.activationId
			)
				throw Error();
			const stream = async function* () {
				let size = 0;
				const hash = createHash("sha256");
				for await (const chunk of req.iterator({ destroyOnReturn: false })) {
					check();
					const data = Buffer.from(chunk);
					size += data.length;
					if (size > metadata.sizeBytes) throw Error();
					hash.update(data);
					yield data;
				}
				check();
				if (
					size !== metadata.sizeBytes ||
					hash.digest("hex") !== metadata.sha256
				)
					throw Error();
			};
			const artifact = artifactSchema.parse(
				await options.import(
					context,
					metadata.mimeType,
					stream(),
					controller.signal,
				),
			);
			check();
			if (
				artifact.sha256 !== metadata.sha256 ||
				artifact.sizeBytes !== metadata.sizeBytes ||
				artifact.mimeType !== metadata.mimeType
			)
				throw Error();
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(artifact));
		} catch {
			if (!res.headersSent && !res.destroyed) {
				res.writeHead(403, {
					"content-type": "application/json",
					"cache-control": "no-store",
					connection: "close",
				});
				res.end(JSON.stringify({ code: "artifact_import_denied" }));
			}
		} finally {
			clearTimeout(timer);
			req.off("aborted", abort);
			res.off("close", abort);
		}
	};
}
