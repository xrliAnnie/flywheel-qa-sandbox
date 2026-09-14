import type Database from "better-sqlite3";
import { z } from "zod";
import {
	HISTORY_PAGE_ROWS,
	historyContentDigest,
	historyRowSchema,
} from "./history-pages.js";
import type { ShipJudgmentHistory } from "./history-query.js";

const utc = z
	.string()
	.datetime()
	.refine((value) => new Date(value).toISOString() === value);
const pageSchema = z
	.object({
		hostingKey: z.string().max(512).optional(),
		token: z.string().regex(/^[a-f0-9]{32}$/),
		url: z.string().url(),
		html: z.string().refine((value) => Buffer.byteLength(value) <= 65536),
		createdAt: utc,
		verifiedAt: utc.optional(),
	})
	.strict();
export type HistoryStagedPage = z.infer<typeof pageSchema>;
const manifestSchema = z
	.object({
		asOf: utc,
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		origin: z.string().url(),
		rows: z.array(historyRowSchema).max(10000),
		pages: z.array(pageSchema.nullable()).min(1).max(500),
		reason: z.enum(["content", "renewal"]),
	})
	.strict();
export type HistoryManifest = z.infer<typeof manifestSchema>;
export interface HistoryLease {
	status: "claimed";
	owner: string;
	generation: number;
}
type Snapshot = ReturnType<ShipJudgmentHistory["read"]>;
type State = {
	history_generation: number;
	history_lease_owner: string | null;
	history_expires_at: string | null;
	next_due_at: string | null;
	building_manifest: string | null;
	published_manifest: string | null;
	history_digest: string | null;
	published_url: string | null;
	published_as_of: string | null;
	published_expires_at: string | null;
	last_error: string | null;
	history_dirty: number;
};
const iso = (now: number) => new Date(now).toISOString();
const RENEW = 12 * 86400000,
	TTL = 14 * 86400000,
	INTERVAL = 1800000;
function json(manifest: HistoryManifest) {
	const value = JSON.stringify(manifestSchema.parse(manifest));
	if (Buffer.byteLength(value) > 32 * 1024 * 1024)
		throw new Error("history_manifest_budget_exceeded");
	return value;
}
function origin(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.origin !== value ||
		url.username ||
		url.password
	)
		throw new Error("invalid_history_origin");
	return value;
}
/** No network in transactions. All page receipts are fenced by the project lease. */
export class ShipJudgmentHistoryState {
	constructor(private readonly db: Database.Database) {}
	private state() {
		return this.db
			.prepare(
				"SELECT * FROM ship_judgment_project_state WHERE project_name='flywheel'",
			)
			.get() as State | undefined;
	}
	private owns(lease: HistoryLease, now: number) {
		const state = this.state();
		return state &&
			state.history_generation === lease.generation &&
			state.history_lease_owner === lease.owner &&
			Date.parse(state.history_expires_at ?? "") > now
			? state
			: undefined;
	}
	view() {
		const row = this.state();
		return {
			url: row?.published_url ?? null,
			asOf: row?.published_as_of ?? null,
			error: row?.last_error ?? null,
			dirty: row?.history_dirty === 1,
		};
	}
	claim(
		owner: string,
		now: number,
	): HistoryLease | { status: "busy" | "deferred" } {
		z.string().min(1).max(200).parse(owner);
		iso(now);
		return this.db
			.transaction(() => {
				this.db
					.prepare(
						"INSERT OR IGNORE INTO ship_judgment_project_state(project_name) VALUES ('flywheel')",
					)
					.run();
				const state = this.state()!;
				if (
					state.history_lease_owner &&
					Date.parse(state.history_expires_at ?? "") > now
				)
					return { status: "busy" as const };
				if (state.next_due_at && Date.parse(state.next_due_at) > now)
					return { status: "deferred" as const };
				const generation = state.history_generation + 1;
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET history_lease_owner=?,history_generation=?,history_expires_at=?,last_attempt_at=?,next_due_at=?,history_dirty=0 WHERE project_name='flywheel'",
					)
					.run(
						owner,
						generation,
						iso(now + 120000),
						iso(now),
						iso(now + INTERVAL),
					);
				return { status: "claimed" as const, owner, generation };
			})
			.immediate();
	}
	begin(
		lease: HistoryLease,
		snapshot: Snapshot,
		reportOrigin: string,
		now: number,
	):
		| { status: "stale" | "unchanged" }
		| { status: "building"; manifest: HistoryManifest } {
		origin(reportOrigin);
		utc.parse(snapshot.asOf);
		if (snapshot.digest !== historyContentDigest(snapshot.rows))
			throw new Error("history_snapshot_digest_mismatch");
		return this.db
			.transaction(() => {
				const state = this.owns(lease, now);
				if (!state) return { status: "stale" as const };
				if (state.building_manifest) {
					const old = manifestSchema.parse(JSON.parse(state.building_manifest));
					if (
						old.origin === reportOrigin &&
						Date.parse(old.asOf) + RENEW > now &&
						old.pages.every(
							(page) => !page || Date.parse(page.createdAt) + RENEW > now,
						)
					) {
						if (old.digest !== snapshot.digest)
							this.db
								.prepare(
									"UPDATE ship_judgment_project_state SET history_dirty=1 WHERE project_name='flywheel'",
								)
								.run();
						return { status: "building" as const, manifest: old };
					}
				}
				const published = state.published_manifest
					? manifestSchema.parse(JSON.parse(state.published_manifest))
					: null;
				const valid =
					published &&
					published.origin === reportOrigin &&
					published.pages.every(
						(page) =>
							page?.verifiedAt && Date.parse(page.createdAt) + RENEW > now,
					) &&
					state.last_error !== "published_url_invalid";
				if (valid && state.history_digest === snapshot.digest) {
					this.db
						.prepare(
							"UPDATE ship_judgment_project_state SET history_lease_owner=NULL,history_expires_at=NULL,building_manifest=NULL,last_error=NULL WHERE project_name='flywheel'",
						)
						.run();
					return { status: "unchanged" as const };
				}
				const manifest: HistoryManifest = {
					asOf: snapshot.asOf,
					digest: snapshot.digest,
					origin: reportOrigin,
					rows: snapshot.rows,
					pages: Array.from(
						{
							length: Math.max(
								1,
								Math.ceil(snapshot.rows.length / HISTORY_PAGE_ROWS),
							),
						},
						() => null,
					),
					reason:
						state.history_digest === snapshot.digest ? "renewal" : "content",
				};
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET building_manifest=? WHERE project_name='flywheel'",
					)
					.run(json(manifest));
				return { status: "building" as const, manifest };
			})
			.immediate();
	}
	private mutate(
		lease: HistoryLease,
		now: number,
		change: (manifest: HistoryManifest) => void,
	) {
		return this.db
			.transaction(() => {
				const state = this.owns(lease, now);
				if (!state?.building_manifest) return false;
				const manifest = manifestSchema.parse(
					JSON.parse(state.building_manifest),
				);
				change(manifest);
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET building_manifest=? WHERE project_name='flywheel'",
					)
					.run(json(manifest));
				return true;
			})
			.immediate();
	}
	stagePage(
		lease: HistoryLease,
		index: number,
		value: HistoryStagedPage,
		now: number,
	) {
		const page = pageSchema.parse(value);
		if (page.verifiedAt)
			throw new Error("history_stage_cannot_claim_verification");
		if (
			Date.parse(page.createdAt) > now ||
			Date.parse(page.createdAt) + RENEW <= now
		)
			throw new Error("history_stage_time_invalid");
		return this.mutate(lease, now, (manifest) => {
			if (
				!Number.isInteger(index) ||
				index < 1 ||
				index > manifest.pages.length
			)
				throw new Error("invalid_history_page");
			const url = new URL(page.url);
			if (
				url.origin !== manifest.origin ||
				url.username ||
				url.password ||
				url.hash ||
				url.search ||
				!new RegExp("^/r/" + page.token + "/?$").test(url.pathname)
			)
				throw new Error("invalid_history_page_url");
			if (manifest.pages.slice(index).some((page) => !page?.verifiedAt))
				throw new Error("history_next_not_verified");
			if (
				manifest.pages.some(
					(existing, position) =>
						position !== index - 1 && existing?.token === page.token,
				)
			)
				throw new Error("history_page_token_reused");
			const existing = manifest.pages[index - 1];
			if (existing && JSON.stringify(existing) !== JSON.stringify(page))
				throw new Error("history_page_already_staged");
			manifest.pages[index - 1] = page;
		});
	}
	verifyPage(lease: HistoryLease, index: number, now: number) {
		return this.mutate(lease, now, (manifest) => {
			const page = manifest.pages[index - 1];
			if (!page) throw new Error("history_page_not_staged");
			if (Date.parse(page.createdAt) > now)
				throw new Error("history_verification_time_invalid");
			page.verifiedAt ??= iso(now);
		});
	}
	finish(lease: HistoryLease, now: number) {
		return this.db
			.transaction(() => {
				const state = this.owns(lease, now);
				if (!state?.building_manifest) return false;
				const manifest = manifestSchema.parse(
					JSON.parse(state.building_manifest),
				);
				if (manifest.pages.some((page) => !page?.verifiedAt))
					throw new Error("history_manifest_incomplete");
				const expiry = Math.min(
					...manifest.pages.map((page) => Date.parse(page!.createdAt) + TTL),
				);
				if (expiry <= now) throw new Error("history_manifest_expired");
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET published_manifest=?,published_url=?,published_as_of=?,published_expires_at=?,history_digest=?,building_manifest=NULL,history_lease_owner=NULL,history_expires_at=NULL,last_error=NULL WHERE project_name='flywheel'",
					)
					.run(
						json(manifest),
						manifest.pages[0]!.url,
						manifest.asOf,
						iso(expiry),
						manifest.digest,
					);
				return true;
			})
			.immediate();
	}
	fail(lease: HistoryLease, code: string, now: number) {
		iso(now);
		z.string()
			.regex(/^[a-z0-9_]{1,120}$/)
			.parse(code);
		return this.db
			.transaction(() => {
				const state = this.state();
				// An expired owner can record its failure only until another generation claims it.
				if (
					!state ||
					state.history_generation !== lease.generation ||
					state.history_lease_owner !== lease.owner
				)
					return false;
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET history_lease_owner=NULL,history_expires_at=NULL,last_error=?,history_dirty=1 WHERE project_name='flywheel'",
					)
					.run(code);
				return true;
			})
			.immediate();
	}
}
