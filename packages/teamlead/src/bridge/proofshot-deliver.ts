/**
 * GEO-151 ProofShot — Lead-side instruction renderer for artifact_delivery.
 *
 * `MailboxLeadRuntime.formatEnvelope` dispatches `event_type ===
 * 'artifact_delivery'` here. We render a markdown instruction that tells the
 * Lead Claude CLI session exactly which Discord MCP tool to call and which
 * files to attach.
 *
 * Why a separate file instead of an inline string in mailbox-lead-runtime?
 *   1. Single-purpose function is easier to unit-test (no need to construct
 *      a full LeadRuntime).
 *   2. CommDBLeadRuntime (rollback path) can call the same renderer.
 *   3. Keeps the formatEnvelope dispatch small.
 *
 * Sizing rules:
 *   - Files > size_cap_bytes (default 25 MB — Discord plugin verified cap) are
 *     listed in the message body as fallback markdown links and omitted from
 *     the `files=[...]` array.
 *   - If files.length > file_count_cap (default 10 — Discord plugin per-msg
 *     cap), the Lead is instructed to send multiple `reply` calls, batches
 *     of `file_count_cap`. The renderer doesn't pre-batch — it just notes
 *     the cap; the Lead's CLI session decides ordering.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import type { LeadEventEnvelope } from "./lead-runtime.js";

const DEFAULT_SIZE_CAP_BYTES = 25 * 1024 * 1024;
const DEFAULT_FILE_COUNT_CAP = 10;

interface SizedFile {
	path: string;
	bytes: number;
	overSized: boolean;
}

function statSizeSafe(p: string): number {
	try {
		return statSync(p).size;
	} catch {
		// File disappeared between manifest write + Lead delivery. Treat as
		// 0 so it doesn't push us over the cap — the Lead reply will see
		// "file not found" when it actually tries to attach.
		return 0;
	}
}

/**
 * Build the instruction text. Pure — only `fs.statSync` for sizing.
 */
export function formatArtifactDelivery(env: LeadEventEnvelope): string {
	const e = env.event;
	const paths = e.paths ?? [];
	const sizeCap = e.size_cap_bytes ?? DEFAULT_SIZE_CAP_BYTES;
	const fileCap = e.file_count_cap ?? DEFAULT_FILE_COUNT_CAP;
	const fallbackText = e.oversize_fallback_text ?? "";
	const chatId = e.chat_thread_id ?? "(no chat_thread_id resolved)";
	const issueRef = e.issue_identifier || e.issue_id || "—";
	const kindLabel = e.kind === "3d" ? "3D capture" : "UI capture";

	const sized: SizedFile[] = paths.map((p) => {
		const bytes = statSizeSafe(p);
		return { path: p, bytes, overSized: bytes > sizeCap };
	});

	const attachable = sized.filter((f) => !f.overSized).map((f) => f.path);
	const oversized = sized.filter((f) => f.overSized);

	const lines: string[] = [
		`[Event #${env.seq}] artifact_delivery`,
		`Issue: ${issueRef} | Exec: ${e.execution_id ?? "—"} | Kind: ${kindLabel}`,
		`Chat-Thread: ${chatId}`,
		`Dedup-Key: ${e.dedup_key ?? "—"} | Attempt: ${e.attempt ?? "—"}`,
		"",
		`Annie's ${kindLabel} 截图来了 (${attachable.length} 个文件).`,
		"",
		"请调用 Discord MCP reply 工具:",
		"```",
		`mcp__plugin_discord_discord__reply(`,
		`  chat_id: "${chatId}",`,
		`  message: "${escapeMessage(buildBodyMessage(issueRef, kindLabel, oversized, fallbackText))}",`,
		`  files: [${attachable.map((p) => `"${p}"`).join(", ")}]`,
		`)`,
		"```",
	];

	if (oversized.length > 0) {
		lines.push("");
		lines.push(
			`⚠️ ${oversized.length} file(s) exceed ${formatBytes(sizeCap)} cap — omitted from attachments. Use the fallback markdown link in the message body:`,
		);
		for (const f of oversized) {
			lines.push(`- ${basename(f.path)} (${formatBytes(f.bytes)})`);
		}
	}

	if (attachable.length > fileCap) {
		lines.push("");
		lines.push(
			`⚠️ ${attachable.length} files exceed Discord's ${fileCap}-files-per-message cap. Send multiple reply() calls in batches of ${fileCap}.`,
		);
	}

	return lines.join("\n");
}

function buildBodyMessage(
	issueRef: string,
	kindLabel: string,
	oversized: SizedFile[],
	fallbackText: string,
): string {
	const parts: string[] = [`${issueRef} ${kindLabel} 截图 ↓`];
	if (oversized.length > 0 && fallbackText) {
		parts.push(fallbackText);
	}
	return parts.join("\n\n");
}

function escapeMessage(s: string): string {
	// Just escape backslashes + double quotes for the markdown code block.
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
