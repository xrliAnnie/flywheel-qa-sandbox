/**
 * FLY-696 M1/② — the account-switch watchdog tick. Piggybacks the Bridge's
 * existing 30s poll (no new timer): reads the durable pending records, fires
 * executeSwitch on those past their deadline (unclaimed by a bot), and posts the
 * result to Alerts. Restart-safe (pending survives a restart → next tick picks
 * it up). One failing record is logged and never wedges the others.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSwitchWatchdogTick } from "../account-heal/account-switch-watchdog.js";
import {
	type PendingSwitch,
	pendingKey,
	writePending,
} from "../account-heal/pending-store.js";

const NOW = Date.parse("2026-07-03T20:05:00.000Z");

let dir: string;
let pendingPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-wd-"));
	pendingPath = join(dir, "account-switch-pending.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<PendingSwitch> = {}): PendingSwitch => ({
	key: pendingKey("alert-1", "personal", 3),
	provider: "claude",
	sourceAlertId: "alert-1",
	observedAccount: "personal",
	observedGeneration: 3,
	scope: "5h",
	resetAt: "2026-07-04T02:30:00.000Z",
	deadlineAt: "2026-07-03T20:01:00.000Z", // past NOW
	createdAt: "2026-07-03T20:00:00.000Z",
	...over,
});

function tick(over: {
	executeSwitch?: ReturnType<typeof vi.fn>;
	post?: ReturnType<typeof vi.fn>;
	onSwitchSuccess?: ReturnType<typeof vi.fn>;
}) {
	const executeSwitch =
		over.executeSwitch ??
		vi.fn(async () => ({
			outcome: "attempted" as const,
			action: "account_switch",
			detail: "🔧 已切 personal→school",
		}));
	const post = over.post ?? vi.fn(async () => {});
	return {
		executeSwitch,
		post,
		onSwitchSuccess: over.onSwitchSuccess,
		run: () =>
			accountSwitchWatchdogTick({
				now: () => NOW,
				pendingPath,
				executeSwitch: executeSwitch as never,
				post: post as never,
				onSwitchSuccess: over.onSwitchSuccess as never,
			}),
	};
}

describe("accountSwitchWatchdogTick", () => {
	it("no pending records → no switch, no post", async () => {
		const t = tick({});
		expect(await t.run()).toBe(0);
		expect(t.executeSwitch).not.toHaveBeenCalled();
	});

	it("does not fire a record whose deadline is still in the future", async () => {
		writePending(
			[rec({ deadlineAt: "2026-07-03T20:10:00.000Z" })],
			pendingPath,
		);
		const t = tick({});
		expect(await t.run()).toBe(0);
		expect(t.executeSwitch).not.toHaveBeenCalled();
	});

	it("does not fire a record a bot has claimed", async () => {
		writePending([rec({ claimedBy: "codex-bot" })], pendingPath);
		const t = tick({});
		expect(await t.run()).toBe(0);
	});

	it("fires each due record and posts its result", async () => {
		writePending(
			[
				rec(),
				rec({ key: "k2", sourceAlertId: "a2", observedAccount: "school" }),
			],
			pendingPath,
		);
		const t = tick({});
		expect(await t.run()).toBe(2);
		expect(t.executeSwitch).toHaveBeenCalledTimes(2);
		expect(t.post).toHaveBeenCalledTimes(2);
		// FLY-929: detail stays the first arg; the disposition rides along second.
		expect(t.post).toHaveBeenCalledWith(
			"🔧 已切 personal→school",
			expect.objectContaining({ outcome: "attempted" }),
		);
	});

	it("a failing executeSwitch is logged and does not wedge the others", async () => {
		writePending([rec(), rec({ key: "k2", sourceAlertId: "a2" })], pendingPath);
		const executeSwitch = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({
				outcome: "attempted",
				action: "account_switch",
				detail: "ok",
			});
		const t = tick({ executeSwitch });
		expect(await t.run()).toBe(1); // second one still fired
		expect(t.post).toHaveBeenCalledTimes(1);
	});

	// FLY-871 R3/W5: a successful switch triggers the post-switch rescue sweep.
	it("fires onSwitchSuccess after a successful (attempted) switch", async () => {
		writePending([rec()], pendingPath);
		const onSwitchSuccess = vi.fn(async () => {});
		const t = tick({ onSwitchSuccess });
		expect(await t.run()).toBe(1);
		expect(onSwitchSuccess).toHaveBeenCalledOnce();
	});

	it("does NOT fire onSwitchSuccess when the switch outcome is needs_human", async () => {
		writePending([rec()], pendingPath);
		const onSwitchSuccess = vi.fn(async () => {});
		const t = tick({
			executeSwitch: vi.fn(async () => ({
				outcome: "needs_human",
				action: "none",
				detail: "no usable account",
			})),
			onSwitchSuccess,
		});
		await t.run();
		expect(onSwitchSuccess).not.toHaveBeenCalled();
	});

	it("a throwing onSwitchSuccess is logged and never wedges the tick", async () => {
		writePending([rec()], pendingPath);
		const onSwitchSuccess = vi.fn(async () => {
			throw new Error("sweep boom");
		});
		const t = tick({ onSwitchSuccess });
		expect(await t.run()).toBe(1); // the switch still counts as fired
		expect(onSwitchSuccess).toHaveBeenCalledOnce();
	});

	// FLY-929 A4: the FULL disposition rides along as post's second argument so
	// the plugin's post site can route needs_human to the owner bot and append
	// the notify digest on notifySuccess. Detail stays the first arg (existing
	// single-arg post impls are untouched).
	it("post receives (detail, disposition) — the full disposition rides along", async () => {
		writePending([rec()], pendingPath);
		const disposition = {
			outcome: "attempted" as const,
			action: "account_switch",
			detail: "🔧 已切 personal→school",
			notifySuccess: { from: "personal", to: "school" },
		};
		const executeSwitch = vi.fn(async () => disposition);
		const t = tick({ executeSwitch });
		expect(await t.run()).toBe(1);
		expect(t.post).toHaveBeenCalledWith(disposition.detail, disposition);
	});
});
