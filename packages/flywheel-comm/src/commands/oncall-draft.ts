import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeOptionalBearer } from "flywheel-config";
import { type OncallReceipt, OncallReceiptStore } from "../oncall-receipts.js";

export interface AlertLookup {
	lane: "thread" | "mailbox";
	correlationKey: string;
	eventId: string;
	kind: string;
	ref: string;
}

export interface OncallDraftCommandOptions {
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
	lookupAlert?: (eventId: string) => Promise<AlertLookup>;
	readDraftBody?: (path: string) => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	afterPageWrite?: (path: string) => void;
}

export interface GenericWritingViolation {
	line: number;
	reason: "local_user_path" | "snowflake" | "credential" | "email";
	text: string;
}

const WRITING_GUARDS: Array<{
	reason: GenericWritingViolation["reason"];
	pattern: RegExp;
}> = [
	{ reason: "local_user_path", pattern: /(?:\/Users\/|\/home\/|\$HOME\b)/ },
	{ reason: "snowflake", pattern: /\b\d{17,20}\b/ },
	{ reason: "credential", pattern: /(?:\bsk-|\bghp_|Bearer\s+)/i },
	{
		reason: "email",
		pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
	},
];

export function findGenericWritingViolations(
	body: string,
): GenericWritingViolation[] {
	const violations: GenericWritingViolation[] = [];
	for (const [index, text] of body.split("\n").entries()) {
		for (const guard of WRITING_GUARDS) {
			if (guard.pattern.test(text)) {
				violations.push({ line: index + 1, reason: guard.reason, text });
			}
		}
	}
	return violations;
}

function valueAfter(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function markerFor(eventId: string): string {
	return `<!-- backfill:${eventId} -->`;
}

export function applyRunbookDraft(
	pageText: string | null,
	draft: OncallReceipt,
): string {
	const marker = markerFor(draft.eventId);
	if (pageText?.includes(marker)) return pageText;
	const body = draft.body?.trim();
	if (!body) throw new Error("draft_body_missing");
	if (pageText === null) {
		return `# \`${draft.kind}\`\n\n${body}\n\n${marker}\n`;
	}
	const base = pageText.trimEnd();
	return `${base}\n\n## 处置记录 ${draft.createdAt.slice(0, 10)}\n\n${body}\n\n${marker}\n`;
}

export function applyContactBookDraft(
	tableText: string,
	draft: OncallReceipt,
): string {
	const marker = markerFor(draft.eventId);
	if (tableText.includes(marker)) return tableText;
	if (!draft.to || !draft.body?.trim())
		throw new Error("contact_draft_incomplete");
	const lines = tableText.split("\n");
	const kindCell = `\`${draft.kind}\``;
	const rowIndex = lines.findIndex((line) => {
		const cells = line.split("|").map((cell) => cell.trim());
		return cells[1] === kindCell;
	});
	if (rowIndex >= 0) {
		const cells = lines[rowIndex]?.split("|").map((cell) => cell.trim()) ?? [];
		const description = cells[3] || draft.body.trim();
		lines[rowIndex] =
			`| ${kindCell} | ${draft.to} | ${description} ${marker} |`;
		return lines.join("\n");
	}
	const base = tableText.trimEnd();
	return `${base}\n| ${kindCell} | ${draft.to} | ${draft.body.trim()} ${marker} |\n`;
}

function receiptRoot(
	env: Readonly<Record<string, string | undefined>>,
): string {
	const stateRoot =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	return join(stateRoot, "oncall-drafts");
}

function safeKindFilename(kind: string): string {
	const name = kind.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	if (!name || name === "." || name === "..") throw new Error("unsafe_kind");
	return `${name}.md`;
}

async function fetchAlertLookup(
	eventId: string,
	opts: OncallDraftCommandOptions,
	env: Readonly<Record<string, string | undefined>>,
): Promise<AlertLookup> {
	if (opts.lookupAlert) return opts.lookupAlert(eventId);
	const token = normalizeOptionalBearer(env.FLYWHEEL_ALERT_DUTY_TOKEN);
	const bridgeUrl =
		env.FLYWHEEL_BRIDGE_URL?.trim() || env.BRIDGE_URL?.trim() || "";
	if (!token || !bridgeUrl) throw new Error("alert_duty_unconfigured");
	const response = await (opts.fetchImpl ?? fetch)(
		`${bridgeUrl.replace(/\/+$/, "")}/duty/alert-tickets/lookup?eventId=${encodeURIComponent(eventId)}`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5_000),
		},
	);
	if (!response.ok) throw new Error(`alert_lookup_failed:${response.status}`);
	const body = (await response.json()) as Partial<AlertLookup>;
	if (
		(body.lane !== "thread" && body.lane !== "mailbox") ||
		!body.correlationKey ||
		body.eventId !== eventId ||
		!body.kind ||
		!body.ref
	) {
		throw new Error("alert_lookup_invalid");
	}
	return body as AlertLookup;
}

function harvest(
	repo: string,
	store: OncallReceiptStore,
	input: { dryRun: boolean; afterPageWrite?: (path: string) => void },
): number {
	const repoRoot = resolve(repo);
	let changed = 0;
	for (const pending of store.list("pending")) {
		const draft = pending.receipt;
		const target =
			draft.book === "runbook"
				? join(
						repoRoot,
						"doc",
						"oncall",
						"runbooks",
						safeKindFilename(draft.kind),
					)
				: join(repoRoot, "doc", "oncall", "contact-book.md");
		const current = existsSync(target) ? readFileSync(target, "utf8") : null;
		const next =
			draft.book === "runbook"
				? applyRunbookDraft(current, draft)
				: applyContactBookDraft(
						current ??
							"# Flywheel contact book\n\n| 类别 | 找谁 | 这类问题是什么 |\n|---|---|---|\n",
						draft,
					);
		if (next !== current) {
			changed += 1;
			if (!input.dryRun) {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, next, "utf8");
				input.afterPageWrite?.(target);
			}
		}
		if (!input.dryRun) store.landPending(draft.draftId);
	}
	return changed;
}

export async function runOncallDraftCommand(
	argv: string[],
	opts: OncallDraftCommandOptions = {},
): Promise<number> {
	const env = opts.env ?? process.env;
	const writeStdout =
		opts.writeStdout ?? ((text) => process.stdout.write(text));
	const writeStderr =
		opts.writeStderr ?? ((text) => process.stderr.write(text));
	const action = argv[0];
	if (action !== "add" && action !== "list" && action !== "harvest") {
		writeStderr(
			"oncall-draft: usage: oncall-draft add|list|harvest [options]\n",
		);
		return 2;
	}
	const store = new OncallReceiptStore(receiptRoot(env));
	try {
		if (action === "list") {
			const debt = store.readBackfillDebt();
			writeStdout(
				argv.includes("--json")
					? `${JSON.stringify(debt)}\n`
					: `owed=${debt.owed.join(",") || "-"} pending=${debt.pending} landed=${debt.landed}\n`,
			);
			return 0;
		}
		if (action === "harvest") {
			const repo = valueAfter(argv, "repo")?.trim();
			if (!repo) {
				writeStderr("oncall-draft: harvest requires --repo <path>\n");
				return 2;
			}
			const changed = harvest(repo, store, {
				dryRun: argv.includes("--dry-run"),
				...(opts.afterPageWrite ? { afterPageWrite: opts.afterPageWrite } : {}),
			});
			writeStdout(`oncall-draft harvest: pages=${changed}\n`);
			return 0;
		}

		const book = valueAfter(argv, "book")?.trim();
		const eventId = valueAfter(argv, "event-id")?.trim();
		const file = valueAfter(argv, "file")?.trim();
		const to = valueAfter(argv, "to")?.trim();
		const author =
			valueAfter(argv, "author")?.trim() ||
			env.FLYWHEEL_LEAD_ID?.trim() ||
			"unknown";
		if (
			(book !== "runbook" && book !== "contact-book") ||
			!eventId ||
			!file ||
			(book === "contact-book" && !to)
		) {
			writeStderr(
				"oncall-draft: add requires --book runbook|contact-book --event-id <id> --file <path|->; contact-book also requires --to\n",
			);
			return 2;
		}
		const body = (
			opts.readDraftBody ??
			((path: string) => readFileSync(path === "-" ? 0 : path, "utf8"))
		)(file).trim();
		const violations = findGenericWritingViolations(body);
		if (violations.length > 0) {
			for (const violation of violations) {
				writeStderr(
					`oncall-draft: ${violation.reason} at line ${violation.line}: ${violation.text}\n`,
				);
			}
			return 3;
		}
		const result =
			book === "runbook"
				? await (async () => {
						const lookup = await fetchAlertLookup(eventId, opts, env);
						return store.writePendingDraft({
							book,
							lane: lookup.lane,
							correlationKey: lookup.correlationKey,
							eventId: lookup.eventId,
							kind: lookup.kind,
							author,
							body,
							ref: lookup.ref,
						});
					})()
				: store.promoteOwedToPending({
						eventId,
						to: to as string,
						author,
						body,
					});
		writeStdout(`${result.draftId}\n`);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeStderr(`oncall-draft: ${message}\n`);
		return message === "owed_receipt_missing" ? 4 : 5;
	}
}
