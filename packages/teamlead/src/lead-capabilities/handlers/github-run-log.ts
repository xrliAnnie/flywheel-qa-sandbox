import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { type Entry, fromBuffer, type ZipFile } from "yauzl";
import {
	type BrowserEgressAddress,
	resolveBrowserEgressTarget,
} from "../browser-egress.js";

const COMPRESSED_LIMIT = 8 * 1024 * 1024,
	EXPANDED_LIMIT = 32 * 1024 * 1024,
	ENTRY_LIMIT = 8 * 1024 * 1024;
const invalid = () => new Error("github_log_archive_invalid");
/** Decode only; archives are never extracted to disk. */
export function parseGithubRunLogZip(
	buffer: Buffer,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let zip: ZipFile | undefined,
			stream: Readable | undefined,
			done = false,
			seen = 0,
			total = 0;
		const files = new Map<string, string>();
		const finish = (failed = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			stream?.destroy();
			zip?.close();
			if (failed) reject(invalid());
			else
				resolve(
					[...files]
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([name, text]) => `--- ${name} ---\n${text}`)
						.join("\n"),
				);
		};
		const abort = () => finish(true);
		const timer = setTimeout(abort, 10000);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted || buffer.length > COMPRESSED_LIMIT) {
			finish(true);
			return;
		}
		fromBuffer(
			buffer,
			{ lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
			(error, opened) => {
				if (error || !opened) {
					finish(true);
					return;
				}
				zip = opened;
				if (done) {
					zip.close();
					return;
				}
				zip.on("error", () => finish(true));
				if (zip.entryCount < 1 || zip.entryCount > 512) {
					finish(true);
					return;
				}
				const names = new Set<string>();
				zip.on("entry", (entry: Entry) => {
					const name = entry.fileName,
						type = (entry.externalFileAttributes >>> 16) & 0xf000;
					const directory = name.endsWith("/");
					if (
						++seen > 512 ||
						name.length > 1024 ||
						names.has(name) ||
						name.includes("\\") ||
						name.startsWith("/") ||
						name.includes(":") ||
						name.split("/").some((part) => part === "." || part === "..") ||
						[...name].some(
							(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
						) ||
						(entry.generalPurposeBitFlag & 1) !== 0 ||
						![0, 8].includes(entry.compressionMethod) ||
						(type !== 0 && type !== (directory ? 0x4000 : 0x8000)) ||
						(!directory && (entry.externalFileAttributes & 0x10) !== 0) ||
						entry.uncompressedSize > ENTRY_LIMIT ||
						entry.uncompressedSize >
							Math.max(1024, entry.compressedSize * 200) ||
						total + entry.uncompressedSize > EXPANDED_LIMIT
					) {
						finish(true);
						return;
					}
					names.add(name);
					total += entry.uncompressedSize;
					if (directory) {
						if (entry.uncompressedSize !== 0) {
							finish(true);
							return;
						}
						zip!.readEntry();
						return;
					}
					zip!.openReadStream(entry, (readError, openedStream) => {
						if (readError || !openedStream) {
							finish(true);
							return;
						}
						stream = openedStream;
						if (done) {
							stream.destroy();
							return;
						}
						let size = 0;
						const chunks: Buffer[] = [];
						stream.on("error", () => finish(true));
						stream.on("data", (chunk: Buffer) => {
							size += chunk.length;
							if (size > ENTRY_LIMIT || size > entry.uncompressedSize) {
								finish(true);
								return;
							}
							chunks.push(chunk);
						});
						stream.on("end", () => {
							if (done) return;
							if (size !== entry.uncompressedSize) {
								finish(true);
								return;
							}
							try {
								files.set(
									name,
									new TextDecoder("utf-8", { fatal: true }).decode(
										Buffer.concat(chunks),
									),
								);
							} catch {
								finish(true);
								return;
							}
							zip!.readEntry();
						});
					});
				});
				zip.on("end", () =>
					finish(seen !== zip!.entryCount || files.size === 0),
				);
				zip.readEntry();
			},
		);
	});
}

/** Storage hosts documented by GitHub for logs/artifacts:
 * https://docs.github.com/en/actions/reference/runners/github-hosted-runners
 * Signed URLs never leave this parent-only reader; GitHub authorization is not forwarded. */
export async function downloadGithubRunLogZip(
	location: string,
	signal: AbortSignal,
	options: {
		lookup?: (hostname: string) => Promise<BrowserEgressAddress[]>;
		request?: typeof httpsRequest;
	} = {},
): Promise<Buffer> {
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		throw invalid();
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		(url.port && url.port !== "443") ||
		!(
			url.hostname === "results-receiver.actions.githubusercontent.com" ||
			/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)
		)
	)
		throw invalid();
	let target: Awaited<ReturnType<typeof resolveBrowserEgressTarget>>;
	try {
		target = await new Promise((resolve, reject) => {
			const stop = () => {
				cleanup();
				reject(invalid());
			};
			const timer = setTimeout(stop, 15000);
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", stop);
			};
			signal.addEventListener("abort", stop, { once: true });
			if (signal.aborted) {
				stop();
				return;
			}
			resolveBrowserEgressTarget(location, {
				lookup: options.lookup,
				signal,
			}).then(
				(value) => {
					cleanup();
					resolve(value);
				},
				() => {
					cleanup();
					reject(invalid());
				},
			);
		});
	} catch {
		throw invalid();
	}
	if (signal.aborted) throw invalid();
	return new Promise((resolve, reject) => {
		let request: ClientRequest | undefined,
			response: IncomingMessage | undefined,
			done = false,
			size = 0;
		const chunks: Buffer[] = [];
		const finish = (failed = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			response?.destroy();
			request?.destroy();
			if (failed) reject(invalid());
			else resolve(Buffer.concat(chunks));
		};
		const abort = () => finish(true),
			timer = setTimeout(abort, 15000);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			finish(true);
			return;
		}
		try {
			request = (options.request ?? httpsRequest)(
				{
					hostname: target.address,
					family: target.family,
					servername: target.hostname,
					port: 443,
					path: url.pathname + url.search,
					method: "GET",
					agent: false,
					rejectUnauthorized: true,
					headers: { Host: target.hostname, Accept: "application/zip" },
				},
				(incoming) => {
					response = incoming;
					if (done) {
						response.destroy();
						return;
					}
					response.on("error", () => finish(true));
					response.on("aborted", () => finish(true));
					const length = response.headers["content-length"];
					if (
						response.statusCode !== 200 ||
						(response.headers["content-encoding"] &&
							response.headers["content-encoding"] !== "identity") ||
						(length !== undefined &&
							(!/^[0-9]+$/.test(length) || Number(length) > COMPRESSED_LIMIT))
					) {
						finish(true);
						return;
					}
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > COMPRESSED_LIMIT) {
							finish(true);
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () =>
						finish(length !== undefined && Number(length) !== size),
					);
				},
			);
			request.on("error", () => finish(true));
			request.end();
		} catch {
			finish(true);
		}
	});
}
