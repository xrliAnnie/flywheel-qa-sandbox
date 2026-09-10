import { resolveAllFlags } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { renderFlagCard } from "../feature-flag-render.js";
import {
	enrichFlagViewsWithStore,
	initializeFlagStore,
	readAutoNarrowRuntimeControl,
} from "../flag-store-runtime.js";

describe("auto narrow runtime flag", () => {
	it("defaults to dry_run and never inherits a wildcard auto row", async () => {
		const store = await StateStore.create(":memory:");
		const runtime = initializeFlagStore(store, {});
		expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toEqual({
			mode: "dry_run",
			degraded: false,
		});
		const db = (
			store as never as {
				db: {
					raw: {
						prepare: (sql: string) => { run: (...args: unknown[]) => void };
					};
				};
			}
		).db.raw;
		db.prepare(
			`INSERT INTO flag_values
			 (flag_name,scope,has_override,raw_value,last_effective,revision,updated_at,updated_by)
			 VALUES ('auto_merge_narrow_gate','*',1,'auto','auto',1,1,'fixture')`,
		).run();
		expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toEqual({
			mode: "dry_run",
			degraded: false,
		});
		store.close();
	});

	it("degrades an unaudited auto row to dry_run", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const runtime = initializeFlagStore(store, {});
			const db = (
				store as never as {
					db: {
						raw: {
							prepare: (sql: string) => { run: (...args: unknown[]) => void };
						};
					};
				}
			).db.raw;
			db.prepare(
				`INSERT INTO flag_values
			 (flag_name,scope,has_override,raw_value,last_effective,revision,updated_at,updated_by)
			 VALUES ('auto_merge_narrow_gate','flywheel',1,'auto','auto',1,1,'fixture')`,
			).run();
			db.prepare(`INSERT INTO flag_value_changelog
			(flag_name,scope,action,to_present,to_raw,to_effective,changed_by,changed_at,reason)
			VALUES ('auto_merge_narrow_gate','flywheel','set',1,'auto','auto','fixture',1,'fixture')`).run();
			expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toEqual({
				mode: "dry_run",
				degraded: true,
				reason: "receipt_missing",
			});
			const view = enrichFlagViewsWithStore(
				resolveAllFlags({ env: {} }),
				runtime,
				["flywheel"],
			).find((candidate) => candidate.name === "auto_merge_narrow_gate")!;
			expect(view.founderControlByProject).toEqual([
				{
					projectName: "flywheel",
					mode: "dry_run",
					degraded: true,
					reason: "receipt_missing",
				},
			]);
			const html = renderFlagCard(view, "phone");
			expect(html).toContain("flywheel: dry_run");
			expect(html).toContain("已降级（receipt_missing）");
		} finally {
			store.close();
		}
	});

	it.each(["garbage", "AUTO", "true", "1", "", "on", "dry_run", "off"])(
		"exposes stored raw %j health through the runtime and founder card",
		async (raw) => {
			const store = await StateStore.create(":memory:");
			try {
				const runtime = initializeFlagStore(store, {});
				const db = (
					store as unknown as {
						db: {
							raw: {
								prepare: (sql: string) => { run: (...args: unknown[]) => void };
							};
						};
					}
				).db.raw;
				db.prepare(`INSERT INTO flag_values
					(flag_name,scope,has_override,raw_value,last_effective,revision,updated_at,updated_by)
					VALUES ('auto_merge_narrow_gate','flywheel',1,?, 'dry_run',1,1,'fixture')`).run(
					raw,
				);
				db.prepare(`INSERT INTO flag_value_changelog
					(flag_name,scope,action,to_present,to_raw,to_effective,changed_by,changed_at,reason)
					VALUES ('auto_merge_narrow_gate','flywheel','set',1,?,'dry_run','fixture',1,'fixture')`).run(
					raw,
				);
				const degraded = raw !== "dry_run" && raw !== "off";
				const expected = {
					mode: raw === "off" ? "off" : "dry_run",
					degraded,
					...(degraded ? { reason: "invalid_raw" } : {}),
				};
				expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toEqual(
					expected,
				);
				const view = enrichFlagViewsWithStore(
					resolveAllFlags({ env: {} }),
					runtime,
					["flywheel"],
				).find((candidate) => candidate.name === "auto_merge_narrow_gate")!;
				expect(view.founderControlByProject).toEqual([
					{ projectName: "flywheel", ...expected },
				]);
				const html = renderFlagCard(view, "phone");
				expect(html).toContain(`flywheel: ${expected.mode}`);
				if (degraded) {
					expect(html).toContain("已降级（invalid_raw）");
				} else {
					expect(html).not.toContain("已降级");
				}
			} finally {
				store.close();
			}
		},
	);

	it("shows revision_mismatch when an auto row advances beyond its control receipt", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const runtime = initializeFlagStore(store, {});
			const firstOpeningAt = "2026-09-09T02:46:00.000Z";
			expect(
				store.applyAutoNarrowControlChange({
					eventId: "11111111-1111-4111-8111-111111111111",
					projectName: "flywheel",
					mode: "auto",
					expectedChangeSeq: 0,
					founderMessageId: "1517000000000000001",
					founderChannelId: "1516209714097291335",
					founderAuthorId: "1138241636057481306",
					messageCreatedAt: "2026-09-09T02:45:00.000Z",
					messageDigest: "a".repeat(64),
					commandText: "现在放开",
					executedBy: "flywheel-eng-lead",
					reason: "founder 1517000000000000001",
					now: Date.parse(firstOpeningAt),
				}),
			).toMatchObject({ ok: true });
			const db = (
				store as unknown as {
					db: { raw: { prepare: (sql: string) => { run: () => void } } };
				}
			).db.raw;
			db.prepare(
				"UPDATE flag_values SET revision = revision + 1 WHERE flag_name = 'auto_merge_narrow_gate' AND scope = 'flywheel'",
			).run();
			const expected = {
				mode: "dry_run",
				degraded: true,
				reason: "revision_mismatch",
			};
			expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toEqual(
				expected,
			);
			const view = enrichFlagViewsWithStore(
				resolveAllFlags({ env: {} }),
				runtime,
				["flywheel"],
			).find((candidate) => candidate.name === "auto_merge_narrow_gate")!;
			expect(view.founderControlByProject).toEqual([
				{ projectName: "flywheel", ...expected },
			]);
			const html = renderFlagCard(view, "phone");
			expect(html).toContain("flywheel: dry_run");
			expect(html).toContain("已降级（revision_mismatch）");
		} finally {
			store.close();
		}
	});

	it("reports the first event time for a continuous auto opening", async () => {
		const store = await StateStore.create(":memory:");
		const runtime = initializeFlagStore(store, {});
		const firstOpeningAt = "2026-09-09T02:46:00.000Z";
		expect(
			store.applyAutoNarrowControlChange({
				eventId: "11111111-1111-4111-8111-111111111111",
				projectName: "flywheel",
				mode: "auto",
				expectedChangeSeq: 0,
				founderMessageId: "1517000000000000001",
				founderChannelId: "1516209714097291335",
				founderAuthorId: "1138241636057481306",
				messageCreatedAt: "2026-09-09T02:45:00.000Z",
				messageDigest: "a".repeat(64),
				commandText: "现在放开",
				executedBy: "flywheel-eng-lead",
				reason: "founder 1517000000000000001",
				now: Date.parse(firstOpeningAt),
			}),
		).toMatchObject({ ok: true });
		expect(
			store.applyAutoNarrowControlChange({
				eventId: "22222222-2222-4222-8222-222222222222",
				projectName: "flywheel",
				mode: "auto",
				expectedChangeSeq: store.getFlagValueChangeSeq(
					"auto_merge_narrow_gate",
					"flywheel",
				),
				founderMessageId: "1517000000000000002",
				founderChannelId: "1516209714097291335",
				founderAuthorId: "1138241636057481306",
				messageCreatedAt: "2026-09-09T02:47:00.000Z",
				messageDigest: "b".repeat(64),
				commandText: "现在放开",
				executedBy: "flywheel-eng-lead",
				reason: "founder 1517000000000000002",
				now: Date.parse("2026-09-09T02:48:00.000Z"),
			}),
		).toMatchObject({ ok: true });
		expect(readAutoNarrowRuntimeControl(runtime, "flywheel")).toMatchObject({
			mode: "auto",
			degraded: false,
			controlEventId: "22222222-2222-4222-8222-222222222222",
			openingEventId: "11111111-1111-4111-8111-111111111111",
			openingAt: firstOpeningAt,
		});
		const view = enrichFlagViewsWithStore(
			resolveAllFlags({ env: {} }),
			runtime,
			["flywheel"],
		).find((candidate) => candidate.name === "auto_merge_narrow_gate")!;
		expect(view).toMatchObject({
			controlAuthority: "founder_message",
			effectiveByProject: [
				{ projectName: "flywheel", value: "auto", isDefault: false },
			],
			founderControlByProject: [
				{
					projectName: "flywheel",
					mode: "auto",
					controlEventId: "11111111-1111-4111-8111-111111111111",
					founderMessageId: "1517000000000000001",
					openingAt: firstOpeningAt,
				},
			],
		});
		const html = renderFlagCard(view, "phone");
		expect(html).toContain("由 founder 原消息控制");
		expect(html).toContain(firstOpeningAt);
		expect(html).toContain("1517000000000000001");
		expect(html).not.toContain("data-ffp-control");
		expect(html).not.toContain("data-ff-enum");
		store.close();
	});
});
