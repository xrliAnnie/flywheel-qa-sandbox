import { Router } from "express";
import {
	htmlAttribute,
	htmlHeadRange,
	scanHtmlTags,
} from "flywheel-comm/report-html";
import { verifyReport } from "flywheel-comm/verify-report";
import {
	leadReportOwnerRequestSchema,
	leadReportPublishReceiptRequestSchema,
} from "./lead-capability-report.js";
import type { ReportEntry, ReportRegistry } from "./report-registry.js";
import { reportUrlForToken } from "./report-url.js";

/** Hosted reads accept only a report ID; URL and ownership are Bridge-resolved. */
export function createLeadReportVerifyRouter(options: {
	registry: ReportRegistry;
	authorize(raw: Readonly<Record<string, unknown>>): Promise<{
		report: ReportEntry;
		assertCurrent(): void;
	}>;
	lookupPublishReceipt?(
		raw: Readonly<Record<string, unknown>>,
	): Promise<{ report?: ReportEntry; assertCurrent(): void }>;
	fetchImpl?: typeof fetch;
}): Router {
	const router = Router();
	router.post("/publish-receipt", async (req, res) => {
		const parsed = leadReportPublishReceiptRequestSchema.safeParse(req.body);
		if (!parsed.success || !options.lookupPublishReceipt) {
			res.status(403).json({ error: "report scope denied" });
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				options.lookupPublishReceipt(parsed.data),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("timeout")), 15000);
				}),
			]);
			result.assertCurrent();
			if (!result.report) {
				res.status(503).json({ status: "unknown" });
				return;
			}
			const url = reportUrlForToken(options.registry, result.report.token);
			if (
				!url ||
				!/^https:\/\/fw-reports-[a-f0-9]{6}\.vercel\.app\/r\/[a-f0-9]{32}\/$/.test(
					url,
				)
			)
				throw new Error("report_scope_denied");
			result.assertCurrent();
			res.json({
				requestId: parsed.data.capability.requestId,
				reportId: result.report.token,
				url,
			});
		} catch {
			res.status(503).json({ status: "unknown" });
		} finally {
			if (timer) clearTimeout(timer);
		}
	});
	router.post("/verify", async (req, res) => {
		const parsed = leadReportOwnerRequestSchema.safeParse(req.body);
		if (
			!parsed.success ||
			parsed.data.capability.operationId !== "report.verify"
		) {
			res.status(403).json({ error: "report scope denied" });
			return;
		}
		const body = parsed.data,
			proof = body.capability;
		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let responseBody: ReadableStream<Uint8Array> | null = null;
		const cancel = () => {
			controller.abort();
			void (reader ? reader.cancel() : responseBody?.cancel())?.catch(() => {});
		};
		const timeout = setTimeout(cancel, 15000);
		const abort = new Promise<never>((_, reject) => {
			controller.signal.addEventListener(
				"abort",
				() => reject(new Error("report_verify_timeout")),
				{ once: true },
			);
		});
		let dispatched = false;
		const work = async () => {
			try {
				const scope = await options.authorize(body);
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				const url = reportUrlForToken(options.registry, proof.reportId);
				if (
					scope.report.token !== proof.reportId ||
					!url ||
					!/^https:\/\/fw-reports-[a-f0-9]{6}\.vercel\.app\/r\/[a-f0-9]{32}\/$/.test(
						url,
					)
				)
					throw new Error("report_verify_unavailable");
				scope.assertCurrent();
				dispatched = true;
				const response = await (options.fetchImpl ?? fetch)(url, {
					method: "GET",
					redirect: "error",
					signal: controller.signal,
				});
				responseBody = response.body;
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				if (response.status >= 300 && response.status < 400) {
					void response.body?.cancel().catch(() => {});
					throw new Error("report_verify_redirect");
				}
				const length = response.headers.get("content-length");
				if (
					length !== null &&
					(!/^\d+$/.test(length) || Number(length) > 1024 * 1024)
				) {
					void response.body?.cancel().catch(() => {});
					throw new Error("report_verify_size");
				}
				if (!response.body) throw new Error("report_verify_empty");
				reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				for (;;) {
					const part = await reader.read();
					controller.signal.throwIfAborted();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > 1024 * 1024) throw new Error("report_verify_size");
					chunks.push(part.value);
				}
				const html = new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.concat(chunks),
				);
				// Reuse the CLI's static nonce/CSP checks with the already bounded response.
				// It never receives a screenshot path or launches a browser here.
				const verified = await verifyReport({
					url,
					fetchImpl: async () =>
						new Response(html, { status: response.status }),
				});
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				const scan = scanHtmlTags(html),
					head = htmlHeadRange(scan);
				const restrictiveCsp =
					head !== undefined &&
					scan.openings.some(
						(tag) =>
							tag.name === "meta" &&
							tag.start >= head.start &&
							tag.start < head.end &&
							htmlAttribute(tag, "http-equiv")?.value?.toLowerCase() ===
								"content-security-policy" &&
							/(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/i.test(
								htmlAttribute(tag, "content")?.value ?? "",
							),
					);
				return {
					requestId: proof.requestId,
					status: "succeeded",
					resourceRefs: [proof.reportId],
					data: {
						reportId: proof.reportId,
						httpStatus: response.status,
						cspValid:
							restrictiveCsp && verified.envelope.checks.scriptCsp !== "fail",
						nonceValid:
							verified.envelope.checks.noncePlaceholder === "pass" &&
							verified.envelope.checks.scriptNonce !== "fail" &&
							verified.envelope.checks.scriptCsp !== "fail",
						receiptId: proof.requestId,
						observedAt: new Date().toISOString(),
					},
				};
			} finally {
				void (reader ? reader.cancel() : responseBody?.cancel())?.catch(
					() => {},
				);
			}
		};
		try {
			res.json(await Promise.race([work(), abort]));
		} catch {
			if (dispatched || controller.signal.aborted)
				res.status(503).json({
					requestId: proof.requestId,
					status: "unknown",
					resourceRefs: [],
				});
			else res.status(403).json({ error: "report scope denied" });
		} finally {
			clearTimeout(timeout);
			cancel();
		}
	});
	return router;
}
