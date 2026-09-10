import { createHash } from "node:crypto";
import { get as getBlob } from "@vercel/blob";
import { htmlMetaHttpEquivContent } from "./report-gateway-html.js";
import { MIGRATED_REPORT_CREATED_AT } from "./report-gateway-migration-manifest.js";
import { isReportExpired, REPORT_RETENTION_MS } from "./report-retention.js";

export const REPORT_GATEWAY_RETENTION_MS = REPORT_RETENTION_MS;
const REPORT_TOKEN_RE = /^[0-9a-f]{32}$/;

interface GatewayBlobResult {
	statusCode: number;
	stream: ReadableStream<Uint8Array> | null;
	headers: { get(name: string): string | null };
	blob: {
		uploadedAt: Date;
		etag: string;
	};
}

export interface ReportGatewayDeps {
	get(
		pathname: string,
		options: { access: "private"; token: string; useCache: false },
	): Promise<GatewayBlobResult | null>;
	now: () => number;
	blobToken: () => string | undefined;
	migratedCreatedAt?: Readonly<Record<string, string>>;
	logError?: (message: string) => void;
}

export function extractReportCsp(html: string): string | undefined {
	return htmlMetaHttpEquivContent(html, "content-security-policy");
}

const defaultDeps: ReportGatewayDeps = {
	get: (pathname, options) => getBlob(pathname, options),
	now: () => Date.now(),
	blobToken: () => process.env.BLOB_READ_WRITE_TOKEN,
	migratedCreatedAt: MIGRATED_REPORT_CREATED_AT,
};

export function createReportGatewayHandler(
	deps: ReportGatewayDeps = defaultDeps,
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		const params = new URL(request.url).searchParams;
		const token = params.get("token") ?? "";
		const audit = params.get("audit");
		if (audit !== null && !/^[0-9a-f]{64}$/.test(audit))
			return new Response("Not found", { status: 404 });
		if (!REPORT_TOKEN_RE.test(token)) {
			return new Response("Not found", { status: 404 });
		}
		const blobToken = deps.blobToken()?.trim();
		if (!blobToken) {
			return new Response("Report storage unavailable", { status: 503 });
		}

		let result: GatewayBlobResult | null;
		try {
			result = await deps.get(`r/${token}/index.html`, {
				access: "private",
				token: blobToken,
				useCache: false,
			});
		} catch {
			return new Response("Report storage unavailable", { status: 502 });
		}
		if (audit !== null && (!result || result.statusCode === 404))
			return serveAudit(deps, token, audit, blobToken);
		if (result?.statusCode !== 200 || !result.stream) {
			return new Response("Not found", { status: 404 });
		}

		const migratedCreatedAt = deps.migratedCreatedAt?.[token];
		let createdAt: number;
		if (migratedCreatedAt !== undefined) {
			createdAt = Date.parse(migratedCreatedAt);
		} else {
			try {
				createdAt = new Date(result.blob.uploadedAt).getTime();
			} catch {
				(deps.logError ?? console.error)(
					"[report-gateway] unable to read Blob uploadedAt",
				);
				return new Response("Report storage unavailable", { status: 502 });
			}
		}
		if (!Number.isFinite(createdAt)) {
			(deps.logError ?? console.error)(
				"[report-gateway] Blob has no authoritative createdAt",
			);
			return new Response("Report storage unavailable", { status: 502 });
		}
		if (isReportExpired(deps.now(), createdAt)) {
			// A new audit can precede replacement of an expired stable HTML.
			// Its own uploadedAt still enforces the identical 14-day boundary.
			if (audit !== null) {
				await result.stream.cancel();
				return serveAudit(deps, token, audit, blobToken);
			}
			return new Response("Not found", { status: 404 });
		}

		if (audit !== null) {
			// Parent TTL is authoritative; a fresh audit cannot extend it.
			await result.stream.cancel();
			return serveAudit(deps, token, audit, blobToken);
		}
		const html = await new Response(result.stream).text();
		const csp = extractReportCsp(html);
		if (!csp) {
			return new Response("Report storage unavailable", { status: 502 });
		}
		try {
			return new Response(html, {
				status: 200,
				headers: {
					"Cache-Control": "private, no-store",
					"Content-Security-Policy": csp,
					"Content-Type": "text/html; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
					"X-Frame-Options": "DENY",
					"X-Robots-Tag": "noindex, nofollow, noarchive",
				},
			});
		} catch {
			(deps.logError ?? console.error)(
				"[report-gateway] unable to construct safe report response",
			);
			return new Response("Report storage unavailable", { status: 502 });
		}
	};
}

async function serveAudit(
	deps: ReportGatewayDeps,
	token: string,
	audit: string,
	blobToken: string,
): Promise<Response> {
	try {
		const sidecar = await deps.get(`r/${token}/${audit}/index.audit.json`, {
			access: "private",
			token: blobToken,
			useCache: false,
		});
		if (sidecar?.statusCode !== 200 || !sidecar.stream)
			return new Response("Not found", { status: 404 });
		const observed = new Date(sidecar.blob.uploadedAt).getTime();
		if (!Number.isFinite(observed))
			return new Response("Report storage unavailable", { status: 502 });
		if (isReportExpired(deps.now(), observed))
			return new Response("Not found", { status: 404 });
		const json = await new Response(sidecar.stream).text();
		if (createHash("sha256").update(json).digest("hex") !== audit)
			return new Response("Report storage unavailable", { status: 502 });
		return new Response(json, {
			status: 200,
			headers: {
				"Cache-Control": "private, no-store",
				"Content-Type": "application/json; charset=utf-8",
				"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
				"X-Robots-Tag": "noindex, nofollow, noarchive",
			},
		});
	} catch {
		return new Response("Report storage unavailable", { status: 502 });
	}
}

export const GET = createReportGatewayHandler();

interface NodeGatewayRequest {
	url?: string;
	headers: Record<string, string | string[] | undefined>;
}

interface NodeGatewayResponse {
	statusCode: number;
	setHeader(name: string, value: string): void;
	end(body?: Uint8Array): void;
}

/** Raw Vercel `/api/*.js` functions use the Node request/response contract. */
export default async function reportGatewayNodeHandler(
	request: NodeGatewayRequest,
	response: NodeGatewayResponse,
): Promise<void> {
	const webResponse = await GET(
		new Request(new URL(request.url ?? "/", "https://report.invalid")),
	);
	response.statusCode = webResponse.status;
	webResponse.headers.forEach((value, name) => response.setHeader(name, value));
	response.end(new Uint8Array(await webResponse.arrayBuffer()));
}
