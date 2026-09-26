/**
 * FLY-709 — `flywheel-comm feature-flags report`.
 *
 * Fetches the read-only feature-flag report HTML from the Bridge loopback
 * endpoint (`GET /api/fleet/flag-report.html`) and hands it to the existing
 * `publish-report` flow → an unguessable hosted URL + Discord delivery (so Annie
 * can open the flag state on her phone). Respects `FLYWHEEL_REMOTE_REPORTS=0`
 * (the same dual-sided kill-switch publish-report honors).
 *
 * Dependency direction: flywheel-comm does NOT import teamlead's renderer (that
 * would cycle) — it only fetches HTML over loopback and reuses publish-report.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReport } from "./publish-report.js";

export interface PublishInput {
	htmlPath: string;
	project: string;
	channelId?: string;
}

export interface FeatureFlagsDeps {
	env?: Record<string, string | undefined>;
	fetchFn?: (
		url: string,
	) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
	/** Returns the publish exit code (0 = success); the command propagates non-zero. */
	publish?: (input: PublishInput) => Promise<number>;
	/** POST helper for the `apply` subcommand (stage → apply). */
	httpJson?: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string },
	) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
	writeFile?: (path: string, data: string) => void;
	log?: (msg: string) => void;
	errorLog?: (msg: string) => void;
	/** Injected for tests; defaults to process.exit. */
	exit?: (code: number) => never;
	/** Injected for tests; defaults to a tmp path. */
	outDefault?: string;
}

const USAGE =
	"usage: flywheel-comm feature-flags report [--project <name>] [--channel <id>] [--out <file>] [--bridge-url <url>]";

function flagVal(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export async function runFeatureFlags(
	args: string[],
	deps: FeatureFlagsDeps = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((m: string) => console.log(m));
	const errorLog = deps.errorLog ?? ((m: string) => console.error(m));
	const exit = deps.exit ?? ((c: number) => process.exit(c));
	const fetchFn =
		deps.fetchFn ??
		((url: string) =>
			fetch(url) as unknown as ReturnType<
				NonNullable<FeatureFlagsDeps["fetchFn"]>
			>);
	const publish =
		deps.publish ??
		(async (input: PublishInput): Promise<number> => {
			const { envelope, exitCode } = await publishReport({
				htmlPath: input.htmlPath,
				project: input.project,
				channelId: input.channelId,
			});
			log(JSON.stringify(envelope));
			return exitCode;
		});
	const writeFile =
		deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf-8"));

	const sub = args[0];
	const rest = args.slice(1);
	const bridgeUrl = (
		flagVal(rest, "--bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");

	// ── apply: the command Annie pastes to the Lead. stage → apply against the
	// loopback flag routes (Origin = the Bridge URL so same-origin passes). ──
	if (sub === "apply") {
		const name = flagVal(rest, "--name");
		const toStr = flagVal(rest, "--to");
		if (!name || (toStr !== "on" && toStr !== "off")) {
			errorLog(
				"usage: flywheel-comm feature-flags apply --name <flag> --to on|off [--bridge-url <url>]",
			);
			return exit(1);
		}
		const httpJson =
			deps.httpJson ??
			((
				u: string,
				init: { method: string; headers: Record<string, string>; body: string },
			) =>
				fetch(u, init) as unknown as ReturnType<
					NonNullable<FeatureFlagsDeps["httpJson"]>
				>);
		const hdr = { "Content-Type": "application/json", Origin: bridgeUrl };
		let staged: { canonical: unknown; confirmToken: string };
		try {
			const sres = await httpJson(`${bridgeUrl}/api/fleet/flag/stage`, {
				method: "POST",
				headers: hdr,
				body: JSON.stringify({ name, to: toStr === "on" }),
			});
			if (!sres.ok) {
				errorLog(`feature-flags apply: stage failed (${sres.status})`);
				return exit(1);
			}
			staged = (await sres.json()) as {
				canonical: unknown;
				confirmToken: string;
			};
		} catch (err) {
			errorLog(
				`feature-flags apply: cannot reach Bridge at ${bridgeUrl}: ${(err as Error).message}`,
			);
			return exit(1);
		}
		const ares = await httpJson(`${bridgeUrl}/api/fleet/flag/apply`, {
			method: "POST",
			headers: hdr,
			body: JSON.stringify({
				canonical: staged.canonical,
				confirmToken: staged.confirmToken,
			}),
		});
		const body = await ares.json().catch(() => ({}));
		log(JSON.stringify(body));
		if (!ares.ok) return exit(1);
		return;
	}

	if (sub !== "report") {
		errorLog(USAGE);
		return exit(1);
	}

	if (env.FLYWHEEL_REMOTE_REPORTS === "0") {
		log(JSON.stringify({ skipped: true, reason: "FLYWHEEL_REMOTE_REPORTS=0" }));
		return;
	}

	const project = flagVal(rest, "--project") ?? "flywheel";
	const channel = flagVal(rest, "--channel");
	const out =
		flagVal(rest, "--out") ??
		deps.outDefault ??
		join(tmpdir(), "flywheel-feature-flags.html");
	// interactive=1 → the phone copy-paste page: report-registry mints the CSP
	// nonce at serve time; local toggles build `feature-flags apply …` commands
	// Annie copies to a Lead (Annie's locked control model; zero network callback).
	const url = `${bridgeUrl}/api/fleet/flag-report.html?interactive=1`;

	let html: string;
	try {
		const res = await fetchFn(url);
		if (!res.ok) {
			errorLog(
				`feature-flags report: Bridge returned ${res.status} for ${url}`,
			);
			return exit(1);
		}
		html = await res.text();
	} catch (err) {
		errorLog(
			`feature-flags report: cannot reach Bridge at ${url}: ${(err as Error).message}`,
		);
		return exit(1);
	}

	writeFile(out, html);
	// Propagate publish/deliver failure — a failed publish must NOT exit 0
	// (Lead-facing automation treats exit 0 as delivered).
	const code = await publish({ htmlPath: out, project, channelId: channel });
	if (code !== 0) return exit(code);
}
