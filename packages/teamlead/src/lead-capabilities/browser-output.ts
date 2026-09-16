import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LeadArtifactStore } from "./artifacts.js";
import {
	BROWSER_TOOL_SCHEMAS,
	type PreparedBrowserCall,
} from "./browser-tools.js";

const denied = () => new Error("browser_output_denied");
const textResult = z
	.object({
		isError: z.boolean().optional(),
		content: z
			.array(
				z
					.object({ type: z.literal("text"), text: z.string().max(262144) })
					.strict(),
			)
			.max(64),
		structuredContent: z.unknown().optional(),
		_meta: z.unknown().optional(),
	})
	.strict();
export interface BrowserProjectedOutput {
	isError?: boolean;
	content: { type: "text"; text: string }[];
}
/** The parent invokes this before the façade boundary. Upstream metadata/resources
 * and local paths are not an authority to disclose files. JS/page text is untrusted QA data. */
export async function projectBrowserOutput(
	name: string,
	output: { result: unknown; artifact?: PreparedBrowserCall["artifact"] },
	options: {
		workerArtifactRoot: string;
		store: LeadArtifactStore;
		assertCurrent(): void;
	},
): Promise<BrowserProjectedOutput> {
	let fd: number | undefined;
	try {
		options.assertCurrent();
		if (!Object.hasOwn(BROWSER_TOOL_SCHEMAS, name)) throw denied();
		const encoded = JSON.stringify(output.result);
		if (!encoded || Buffer.byteLength(encoded) > 4 * 1024 * 1024)
			throw denied();
		// Do not forward provider exceptions containing local paths or internal context.
		if (z.object({ isError: z.literal(true) }).safeParse(output.result).success)
			return {
				isError: true,
				content: [{ type: "text", text: "browser_tool_failed" }],
			};
		const raw = textResult.parse(output.result);
		if (name === "take_screenshot") {
			const artifact = output.artifact;
			if (!artifact || !z.string().uuid().safeParse(artifact.handle).success)
				throw denied();
			const extensions: Record<string, string> = {
				"image/png": "png",
				"image/jpeg": "jpeg",
				"image/webp": "webp",
			};
			const extension = Object.hasOwn(extensions, artifact.mimeType)
				? extensions[artifact.mimeType]
				: undefined;
			if (
				!extension ||
				realpathSync(options.workerArtifactRoot) !==
					options.workerArtifactRoot ||
				artifact.path !==
					join(options.workerArtifactRoot, `${artifact.handle}.${extension}`)
			)
				throw denied();
			const root = lstatSync(options.workerArtifactRoot);
			if (
				!root.isDirectory() ||
				root.isSymbolicLink() ||
				(root.mode & 0o077) !== 0 ||
				root.uid !== process.getuid?.()
			)
				throw denied();
			fd = openSync(
				artifact.path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			const before = fstatSync(fd);
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.size < 8 ||
				before.size > 25 * 1024 * 1024
			)
				throw denied();
			const data = Buffer.alloc(before.size + 1);
			let count = 0;
			while (count < data.length) {
				const read = readSync(fd, data, count, data.length - count, null);
				if (!read) break;
				count += read;
			}
			const after = fstatSync(fd);
			options.assertCurrent();
			if (
				count !== before.size ||
				after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs
			)
				throw denied();
			const bytes = data.subarray(0, count);
			const valid =
				extension === "png"
					? bytes
							.subarray(0, 8)
							.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
					: extension === "jpeg"
						? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
						: bytes.subarray(0, 4).toString() === "RIFF" &&
							bytes.subarray(8, 12).toString() === "WEBP";
			if (!valid) throw denied();
			const published = await options.store.put(bytes, artifact.mimeType);
			options.assertCurrent();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							artifactHandle: published.handle,
							relativePath: published.relativePath,
							mimeType: published.mimeType,
							size: published.size,
							sha256: published.sha256,
						}),
					},
				],
			};
		}
		if (output.artifact) throw denied();
		const content = raw.content.map((item) => {
			if (item.text.includes(dirname(options.workerArtifactRoot)))
				throw denied();
			const text =
				name === "get_network_request" || name === "list_network_requests"
					? item.text.replace(
							/^(\s*(?:-\s*)?(?:cookie|set-cookie|authorization|proxy-authorization)\s*:)\s*[^\r\n]*(?:\r?\n[\t ][^\r\n]*)*/gim,
							"$1 [redacted]",
						)
					: item.text;
			return { type: "text" as const, text };
		});
		const result = { content };
		if (Buffer.byteLength(JSON.stringify(result)) > 262144) throw denied();
		options.assertCurrent();
		return result;
	} catch {
		throw denied();
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
