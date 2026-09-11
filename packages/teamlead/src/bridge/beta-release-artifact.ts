import type { Readable } from "node:stream";
import { fromBuffer, type ZipFile } from "yauzl";

/** Never extracts to disk. Both declared and observed sizes are admission boundaries. */
export function parseBetaReceiptZip(
	buffer: Buffer,
	signal: AbortSignal,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let zip: ZipFile | undefined;
		let stream: Readable | undefined;
		let done = false;
		let value: unknown;
		let seen = 0;
		const finish = (error?: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			stream?.destroy();
			zip?.close();
			if (error) reject(new Error("beta_artifact_invalid"));
			else resolve(value);
		};
		const onAbort = () => finish(true);
		const timer = setTimeout(onAbort, 10000);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted || buffer.length > 65536) {
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
				if (zip.entryCount !== 1) {
					finish(true);
					return;
				}
				zip.on("entry", (entry) => {
					const type = (entry.externalFileAttributes >>> 16) & 0xf000;
					if (
						++seen !== 1 ||
						entry.fileName !== "receipt.json" ||
						(type !== 0 && type !== 0x8000) ||
						(entry.externalFileAttributes & 0x10) !== 0 ||
						(entry.generalPurposeBitFlag & 1) !== 0 ||
						entry.uncompressedSize > 4096
					) {
						finish(true);
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
							if (size > 4096) {
								finish(true);
								return;
							}
							chunks.push(chunk);
						});
						stream.on("end", () => {
							if (done) return;
							try {
								value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
							} catch {
								finish(true);
								return;
							}
							zip!.readEntry();
						});
					});
				});
				zip.on("end", () => finish(seen !== 1));
				zip.readEntry();
			},
		);
	});
}
