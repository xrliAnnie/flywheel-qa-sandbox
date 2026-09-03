/**
 * FLY-203: /api/reports — remote report pipeline Bridge endpoints.
 *
 *   POST /publish  {projectName, html, title?}
 *     → stage (zero fs) → Vercel deploy (full retained set) → commit
 *     → { url: https://<fw-reports-xxxx>.vercel.app/r/<token>/, reportId }
 *
 *   POST /deliver  {url, projectName, title?, channelId?, screenshotPath?}
 *     → resolve channel (explicit param → ProjectEntry.generalChannel → 400)
 *     → ONE Discord message: screenshot attachment + link (or link-only)
 *
 * Ownership (Codex design review R2#4): this router owns business logic. Auth —
 * including the "no apiToken → 503" sensitive-surface refusal — is owned by
 * the plugin mount layer.
 *
 * Transaction semantics are documented in report-registry.ts. Publishes are
 * serialized through an in-process promise-chain mutex: the registry
 * read-modify-write plus the full-set redeploy must never interleave.
 */

import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	type PostFileResult,
	postDiscordMessageWithFile,
} from "./discord-post-file.js";
import {
	MAX_DISCORD_MESSAGE_LENGTH,
	type PostDiscordResult,
	postDiscordMessageToChannel,
} from "./discord-utils.js";
import { writeTokenReportReceipt } from "./notify-receipts.js";
import type { ReportHostOverride } from "./report-host-override.js";
import {
	ReportHtmlInvalidError,
	type ReportRegistry,
} from "./report-registry.js";
import { deployFilesToVercel } from "./vercel-deploy.js";

const MAX_HTML_SIZE = 512 * 1024; // 512 KB — same cap as /api/publish-html
const MAX_TITLE_LENGTH = 200;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024; // Discord verified cap
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
export const MAX_OUTSTANDING_REPORT_PUBLISHES = 8;
type ReportCredentialTier = "master" | "ingest";

export type ReportPostTextFn = (
	channelId: string,
	content: string,
	botToken: string,
) => Promise<PostDiscordResult>;

export interface ReportsRouterOptions {
	vercelToken: string | undefined;
	discordBotToken: string | undefined;
	/** Call-time sender resolution for identities that can change after boot. */
	resolveDiscordBotToken?: () => string | undefined;
	projects: ProjectEntry[];
	registry: ReportRegistry;
	hostOverride?: ReportHostOverride;
	/** Resolve an issue identifier to its existing Lead-owned Discord thread. */
	resolveIssueThread: (
		issueIdentifier: string,
		projectName: string,
	) => string | undefined | Promise<string | undefined>;
	/** Test seams. */
	deployFiles?: typeof deployFilesToVercel;
	postWithFile?: typeof postDiscordMessageWithFile;
	postText?: ReportPostTextFn;
	/** FLY-929 B1 test seam — the receipt writer (P-expect gated internally). */
	writeReceipt?: typeof writeTokenReportReceipt;
}

function publicReportUrl(
	hostOverride: ReportHostOverride | undefined,
	vercelProjectName: string,
	token: string,
): string {
	return hostOverride
		? `${hostOverride.publicBaseUrl}/${vercelProjectName}/r/${token}/`
		: `https://${vercelProjectName}.vercel.app/r/${token}/`;
}

export type PreviewFileRead =
	| { ok: true; data: Buffer; filename: string; realPath: string }
	| { ok: false; reason: string };

/**
 * Validate AND read a screenshot against the previews-root contract in one
 * fd-pinned operation (Codex design R1#2 + R2#3; code review R1#2 TOCTOU).
 *
 * Containment is `path.relative` semantics — a sibling directory like
 * `previews-evil/` cannot pass. The file is opened ONCE with O_NOFOLLOW
 * (no symlink at the leaf) + O_NONBLOCK (a FIFO must not block the event
 * loop); every subsequent check (regular file, size cap, PNG magic) and the
 * full content read use that same fd, so a caller racing a file swap after
 * validation cannot change what gets posted to Discord.
 */
export function readPreviewFile(
	previewsDir: string,
	filePath: string,
): PreviewFileRead {
	if (typeof filePath !== "string" || !isAbsolute(filePath)) {
		return { ok: false, reason: "screenshotPath must be an absolute path" };
	}
	try {
		if (lstatSync(filePath).isSymbolicLink()) {
			return { ok: false, reason: "screenshotPath must not be a symlink" };
		}
	} catch {
		return { ok: false, reason: "screenshotPath does not exist" };
	}

	let realRoot: string;
	let realFile: string;
	try {
		realRoot = realpathSync(previewsDir);
		realFile = realpathSync(filePath);
	} catch {
		return {
			ok: false,
			reason: "screenshotPath or previews root could not be resolved",
		};
	}
	const rel = relative(realRoot, realFile);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
		return {
			ok: false,
			reason: "screenshotPath must live inside the previews directory",
		};
	}

	// Single open — all checks + the content read are pinned to this fd.
	let fd: number;
	try {
		fd = openSync(
			realFile,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
	} catch {
		return {
			ok: false,
			reason: "screenshot could not be opened (missing or symlink)",
		};
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) {
			return {
				ok: false,
				reason: "screenshotPath must be a regular file",
			};
		}
		if (st.size > MAX_SCREENSHOT_BYTES) {
			return {
				ok: false,
				reason: `screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`,
			};
		}
		const head = Buffer.alloc(4);
		const n = readSync(fd, head, 0, 4, 0);
		if (n < 4 || !head.equals(PNG_MAGIC)) {
			return { ok: false, reason: "screenshot is not a PNG" };
		}
		const data = readFileSync(fd);
		return { ok: true, data, filename: basename(realFile), realPath: realFile };
	} catch {
		return { ok: false, reason: "screenshot could not be read" };
	} finally {
		closeSync(fd);
	}
}

/** Build the one-message content: title line + link. `<url>` suppresses the
 *  Discord auto-embed when a screenshot is attached (it would be redundant). */
export function buildReportMessage(
	title: string,
	projectName: string,
	url: string,
	hasScreenshot: boolean,
): string {
	const link = hasScreenshot ? `<${url}>` : url;
	const content = `📊 **${title}** · ${projectName}\n${link}`;
	return content.length > MAX_DISCORD_MESSAGE_LENGTH
		? content.slice(0, MAX_DISCORD_MESSAGE_LENGTH)
		: content;
}

export function createReportsRouter(opts: ReportsRouterOptions): Router {
	const router = Router();
	const deployFiles = opts.deployFiles ?? deployFilesToVercel;
	const postWithFile = opts.postWithFile ?? postDiscordMessageWithFile;
	const postText =
		opts.postText ??
		((channelId, content, botToken) =>
			postDiscordMessageToChannel(channelId, content, botToken, {
				origin: "automation",
			}));

	// In-process publish mutex (promise chain).
	let publishChain: Promise<void> = Promise.resolve();
	let outstandingPublishes = 0;

	router.post("/publish", (req, res) => {
		const run = async (): Promise<void> => {
			const credentialTier = res.locals.reportCredentialTier as
				| ReportCredentialTier
				| undefined;
			if (credentialTier !== "master" && credentialTier !== "ingest") {
				res.status(401).json({ error: "report credential tier missing" });
				return;
			}
			const body = (req.body ?? {}) as Record<string, unknown>;
			const { projectName, html, title } = body;
			if (credentialTier === "ingest") {
				const normalizedProject =
					typeof projectName === "string" ? projectName.trim() : "";
				if (
					!normalizedProject ||
					!opts.projects.some(
						(project) => project.projectName === normalizedProject,
					)
				) {
					res.status(403).json({
						error: "ingest report publish requires a configured projectName",
					});
					return;
				}
			}
			if (!opts.vercelToken) {
				res.status(501).json({
					error:
						"report publishing not available — VERCEL_TOKEN not configured",
				});
				return;
			}

			if (typeof projectName !== "string" || projectName.trim().length === 0) {
				res.status(400).json({
					error: "projectName is required and must be a non-empty string",
				});
				return;
			}
			if (typeof html !== "string" || html.trim().length === 0) {
				res.status(400).json({
					error: "html is required and must be a non-empty string",
				});
				return;
			}
			if (Buffer.byteLength(html, "utf-8") > MAX_HTML_SIZE) {
				res.status(400).json({
					error: `html exceeds maximum size of ${MAX_HTML_SIZE} bytes`,
				});
				return;
			}
			if (title !== undefined) {
				if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
					res.status(400).json({
						error: `title must be a string of at most ${MAX_TITLE_LENGTH} characters`,
					});
					return;
				}
			}

			let staged: ReturnType<ReportRegistry["stagePublish"]>;
			try {
				staged = opts.registry.stagePublish(
					projectName.trim(),
					html,
					title as string | undefined,
				);
			} catch (err) {
				if (err instanceof ReportHtmlInvalidError) {
					res.status(400).json({ error: err.message });
					return;
				}
				console.error("[reports] stagePublish failed:", (err as Error).message);
				res.status(500).json({ error: "report staging failed" });
				return;
			}

			let deploymentId: string;
			try {
				const result = await deployFiles(
					opts.vercelToken,
					staged.vercelProjectName,
					staged.deployFiles,
					undefined,
					opts.hostOverride?.apiBaseUrl,
				);
				deploymentId = result.deploymentId;
			} catch (err) {
				staged.abort();
				console.error("[reports] deploy failed:", (err as Error).message);
				res.status(502).json({ error: "report publishing failed" });
				return;
			}

			try {
				staged.commit();
			} catch (err) {
				// Vercel cannot be rolled back; local registry stays old. The
				// hosted set temporarily contains a report the registry doesn't
				// know about — the next successful publish realigns. Log token +
				// deployment id (NOT the full private URL) for operator recovery.
				console.error(
					`[reports] commit failed after successful deploy (token=${staged.entry.token}, deploymentId=${deploymentId}): ${(err as Error).message}`,
				);
				res.status(502).json({ error: "report publish commit failed" });
				return;
			}
			console.info(
				`[reports] publish succeeded credentialTier=${credentialTier} project=${JSON.stringify(projectName.trim())}`,
			);

			res.json({
				url: publicReportUrl(
					opts.hostOverride,
					staged.vercelProjectName,
					staged.entry.token,
				),
				reportId: staged.entry.token,
			});
		};

		if (outstandingPublishes >= MAX_OUTSTANDING_REPORT_PUBLISHES) {
			res.status(429).json({ error: "too many outstanding report publishes" });
			return;
		}
		outstandingPublishes += 1;
		// Serialize publishes; errors are already turned into responses inside
		// run(), but guard the chain against unexpected rejections anyway.
		publishChain = publishChain
			.then(run)
			.catch((err) => {
				console.error("[reports] publish handler error:", err);
				if (!res.headersSent) {
					res.status(500).json({ error: "internal error" });
				}
			})
			.finally(() => {
				outstandingPublishes -= 1;
			});
	});

	router.post("/deliver", async (req, res) => {
		const discordBotToken =
			opts.resolveDiscordBotToken?.() ?? opts.discordBotToken;
		if (!discordBotToken) {
			res.status(501).json({
				error:
					"report delivery not available — Discord bot token not configured",
			});
			return;
		}

		const body = (req.body ?? {}) as Record<string, unknown>;
		const {
			url,
			projectName,
			title,
			channelId,
			issueIdentifier,
			screenshotPath,
		} = body;
		if (typeof url !== "string" || url.trim().length === 0) {
			res.status(400).json({
				error: "url is required and must be a non-empty string",
			});
			return;
		}
		if (typeof projectName !== "string" || projectName.trim().length === 0) {
			res.status(400).json({
				error: "projectName is required and must be a non-empty string",
			});
			return;
		}
		if (
			title !== undefined &&
			(typeof title !== "string" || title.length > MAX_TITLE_LENGTH)
		) {
			res.status(400).json({
				error: `title must be a string of at most ${MAX_TITLE_LENGTH} characters`,
			});
			return;
		}
		if (channelId !== undefined && issueIdentifier !== undefined) {
			res.status(400).json({
				error: "channelId and issueIdentifier are mutually exclusive",
			});
			return;
		}
		if (
			issueIdentifier !== undefined &&
			(typeof issueIdentifier !== "string" ||
				!/^[A-Z][A-Z0-9]*-\d+$/.test(issueIdentifier.trim()))
		) {
			res.status(400).json({
				error:
					"issueIdentifier must be a Linear issue identifier such as FLY-1463",
			});
			return;
		}
		// FLY-929 B1: OPTIONAL delivery-receipt fields. `expectedDate` is
		// authoritative from the CLI (computed under TOKEN_USAGE_TIMEZONE) — the
		// Bridge only validates shape, never recomputes. Absent fields = the
		// pre-FLY-929 request, byte-compat (no receipt is written).
		const { kind, expectedDate } = body;
		if (kind !== undefined && (typeof kind !== "string" || kind.length > 64)) {
			res.status(400).json({
				error: "kind must be a string of at most 64 characters",
			});
			return;
		}
		if (
			expectedDate !== undefined &&
			(typeof expectedDate !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate))
		) {
			res.status(400).json({
				error: "expectedDate must be a YYYY-MM-DD string",
			});
			return;
		}
		const writeReceipt = opts.writeReceipt ?? writeTokenReportReceipt;
		const recordReceipt = (messageId: string | undefined) => {
			if (kind !== "token_report" || !expectedDate) return;
			writeReceipt({
				date: expectedDate,
				...(messageId ? { messageId } : {}),
			});
		};

		// Channel resolution: explicit param OR issue thread, otherwise the
		// pre-FLY-1463 project generalChannel fallback.
		let channel: string | undefined;
		if (typeof channelId === "string" && channelId.trim().length > 0) {
			channel = channelId.trim();
		} else if (typeof issueIdentifier === "string") {
			channel = await opts.resolveIssueThread(
				issueIdentifier.trim(),
				projectName.trim(),
			);
			if (!channel) {
				res.status(404).json({ error: "issue_thread_not_found" });
				return;
			}
		} else {
			const project = opts.projects.find(
				(p) => p.projectName === projectName.trim(),
			);
			channel = project?.generalChannel;
		}
		if (!channel) {
			res.status(400).json({
				error:
					"no Discord channel resolvable — pass channelId or configure generalChannel for the project",
			});
			return;
		}

		// Screenshot validation + fd-pinned read (previews-root contract).
		let preview:
			| { data: Buffer; filename: string; realPath: string }
			| undefined;
		if (screenshotPath !== undefined) {
			if (typeof screenshotPath !== "string") {
				res.status(400).json({ error: "screenshotPath must be a string" });
				return;
			}
			const check = readPreviewFile(
				opts.registry.previewsDir(),
				screenshotPath,
			);
			if (!check.ok) {
				res.status(400).json({ error: check.reason });
				return;
			}
			preview = check;
		}

		const message = buildReportMessage(
			typeof title === "string" && title.length > 0 ? title : "Report",
			projectName.trim(),
			url.trim(),
			preview !== undefined,
		);

		if (preview) {
			const result: PostFileResult = await postWithFile(
				channel,
				message,
				{ data: preview.data, filename: preview.filename },
				discordBotToken,
			);
			if (!result.ok) {
				res.status(502).json({ error: result.error });
				return;
			}
			// Best-effort preview cleanup after a successful send.
			try {
				rmSync(preview.realPath);
			} catch {
				// non-fatal
			}
			recordReceipt(result.messageId);
			res.json({ ok: true, messageId: result.messageId });
			return;
		}

		const result: PostDiscordResult = await postText(
			channel,
			message,
			discordBotToken,
		);
		if (!result.ok) {
			res.status(502).json({ error: result.error });
			return;
		}
		recordReceipt(result.messageIds[0]);
		res.json({ ok: true, messageId: result.messageIds[0] });
	});

	return router;
}
