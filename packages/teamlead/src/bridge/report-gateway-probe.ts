import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ReportBlobStore } from "./report-blob-store.js";

export type GatewayRequest = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

/** Raw HTTPS: no implicit Accept-Encoding and no transparent decompression. */
export const requestGateway: GatewayRequest = async (url, init) =>
	new Promise((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method: "GET",
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				signal: AbortSignal.timeout(15_000),
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 2_097_152) {
						response.destroy(new Error("report gateway response too large"));
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", () =>
					reject(new Error("report gateway response failed")),
				);
				response.on("end", () => {
					const headers = new Headers();
					for (const [name, value] of Object.entries(response.headers))
						if (value !== undefined)
							headers.set(
								name,
								Array.isArray(value) ? value.join(", ") : value,
							);
					const status = response.statusCode ?? 502;
					resolve(
						new Response(
							[204, 205, 304].includes(status)
								? null
								: new Uint8Array(Buffer.concat(chunks)),
							{ status, headers },
						),
					);
				});
			},
		);
		request.on("error", () =>
			reject(new Error("report gateway request failed")),
		);
		request.end();
	});

export async function probeGatewayFormats(input: {
	bound: Pick<ReportBlobStore, "putRawObject" | "deleteReports">;
	projectName: string;
	request?: GatewayRequest;
}): Promise<void> {
	const request = input.request ?? requestGateway;
	const tokens = [
		randomBytes(16).toString("hex"),
		randomBytes(16).toString("hex"),
	];
	const html =
		'<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;"></head><body>report gateway probe</body></html>';
	try {
		await input.bound.putRawObject(`r/${tokens[0]}/index.html`, gzipSync(html));
		await input.bound.putRawObject(
			`r/${tokens[1]}/index.html`,
			Buffer.from([0x1f, 0x8b, 0, 1]),
		);
		for (const [index, encoding] of [
			"gzip",
			undefined,
			"gzip;q=0",
			undefined,
		].entries()) {
			const token = tokens[index === 3 ? 1 : 0];
			const response = await request(
				`https://${input.projectName}.vercel.app/r/${token}/`,
				{
					headers:
						encoding === undefined ? {} : { "Accept-Encoding": encoding },
				},
			);
			if (index === 3) {
				if (response.status !== 502)
					throw new Error("gateway format probe corrupt object accepted");
				continue;
			}
			if (
				response.status !== 200 ||
				!response.headers.get("content-security-policy") ||
				!response.headers.get("content-type")?.includes("text/html") ||
				response.headers.get("content-encoding") !==
					(index === 0 ? "gzip" : null)
			)
				throw new Error("gateway format probe response mismatch");
			const bytes = Buffer.from(await response.arrayBuffer());
			let content: string;
			try {
				content = (
					index === 0
						? gunzipSync(bytes, { maxOutputLength: 1_048_576 })
						: bytes
				).toString("utf8");
			} catch {
				throw new Error("gateway format probe invalid compression");
			}
			if (
				!content.includes("<html") ||
				!content.includes("report gateway probe")
			)
				throw new Error("gateway format probe body mismatch");
		}
	} finally {
		await input.bound.deleteReports(tokens);
	}
}
