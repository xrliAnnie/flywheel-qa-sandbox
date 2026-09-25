import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	VercelAccountStore,
	VercelReadNote,
} from "../../vercel-quota/vercel-account-store.js";
import {
	buildVercelQuotaSection,
	formatVercelBytes,
	RETIRED_VERCEL_ACCOUNTS,
} from "../account-quota-vercel.js";

const GENERATED_AT = "2026-09-25T08:30:00.000Z";
const EMAIL = "owner.person@example.test";
const digest = (email: string) =>
	createHash("sha256").update(email).digest("hex");

function reading(
	overrides: {
		account?: Partial<NonNullable<VercelAccountStore["account"]>>;
		blob?: Partial<NonNullable<VercelAccountStore["blob"]>>;
	} = {},
): VercelAccountStore {
	return {
		version: 1,
		observedAt: "2026-09-25T08:00:00.000Z",
		account: {
			emailSha256: digest(EMAIL),
			username: "xrliannie",
			teamSlug: "xrliannies-projects",
			plan: "pro",
			billingStatus: "active",
			periodEnd: "2026-10-24T07:00:00.000Z",
			canceled: false,
			...overrides.account,
		},
		accountNote: null,
		blob: {
			status: "available",
			sizeBytes: 1_051_925,
			count: 23,
			usageQuotaExceeded: false,
			...overrides.blob,
		},
		blobNote: null,
	};
}

function failed(
	accountNote: VercelReadNote | null,
	blobNote: VercelReadNote,
): VercelAccountStore {
	const base = reading();
	return accountNote === null
		? { ...base, blob: null, blobNote }
		: { ...base, account: null, accountNote, blob: null, blobNote };
}

const emails = {
	personal: " Owner.Person@Example.test ",
	business: "b@x.test",
};

function live(store: VercelAccountStore | null, claudeEmails = emails) {
	return buildVercelQuotaSection(store, {
		generatedAt: GENERATED_AT,
		claudeEmails,
	}).rows[0]!;
}

describe("FLY-2875 Vercel quota section", () => {
	it("renders the Pro report-hosting account as the in-use row with its next charge date", () => {
		const section = buildVercelQuotaSection(reading(), {
			generatedAt: GENERATED_AT,
			claudeEmails: emails,
		});
		expect(section.observedAt).toBe("2026-09-25T08:00:00.000Z");
		expect(section.rows).toEqual([
			{
				name: "personal",
				planDisplay: "Pro",
				team: "team xrliannies-projects",
				active: true,
				retired: false,
				note: null,
				nextCharge: "10/24 周六",
				blobLines: [
					"正常",
					"已存 1.1 MB · 23 个对象",
					"本期占比：读不到（接口不给额度上限）",
				],
			},
			{
				name: "personal2",
				planDisplay: "Hobby",
				team: null,
				active: false,
				retired: true,
				note: "已停用，不再使用",
				nextCharge: "已停用",
				blobLines: ["不再使用"],
			},
		]);
		expect(RETIRED_VERCEL_ACCOUNTS).toEqual([
			{ alias: "personal2", plan: "Hobby" },
		]);
	});

	it("maps the alias by email digest, falling back to the Vercel username", () => {
		expect(live(reading()).name).toBe("personal");
		expect(live(reading(), { a: EMAIL, z: EMAIL }).name).toBe("a");
		expect(live(reading(), { z: EMAIL, a: EMAIL }).name).toBe("a");
		expect(live(reading(), {}).name).toBe("xrliannie");
		expect(
			buildVercelQuotaSection(reading(), { generatedAt: GENERATED_AT }).rows[0]!
				.name,
		).toBe("xrliannie");
	});

	it("drops the retired row when the live account carries its alias", () => {
		const rows = buildVercelQuotaSection(reading(), {
			generatedAt: GENERATED_AT,
			claudeEmails: { personal2: EMAIL },
		}).rows;
		expect(rows.map((row) => row.name)).toEqual(["personal2"]);
		expect(rows[0]!.retired).toBe(false);
	});

	it.each<[string, VercelAccountStore | null, string]>([
		["never read", null, "读不到（尚未读取）"],
		[
			"unauthorized",
			failed("unauthorized", "unauthorized"),
			"读不到（token 已失效）",
		],
		[
			"no token",
			failed("no_token", "no_token"),
			"读不到（本机没有 Vercel token）",
		],
		[
			"refresh error",
			failed("refresh_failed", "refresh_failed"),
			"读不到（本轮读取出错）",
		],
		["hobby", reading({ account: { plan: "hobby" } }), "不扣费（Hobby 免费）"],
		[
			"enterprise with a future period",
			reading({ account: { plan: "enterprise" } }),
			"读不到（接口未给扣费日）",
		],
		[
			"unknown plan with a future period",
			reading({ account: { plan: "plus_v2" } }),
			"读不到（接口未给扣费日）",
		],
		[
			"canceled with a period",
			reading({ account: { canceled: true } }),
			"已取消 · 10/24 周六 到期",
		],
		[
			"canceled without a period",
			reading({ account: { canceled: true, periodEnd: null } }),
			"已取消",
		],
		[
			"past due",
			reading({ account: { billingStatus: "past_due" } }),
			"读不到（账单状态 past_due）",
		],
		[
			"unknown status",
			reading({ account: { billingStatus: null } }),
			"读不到（账单状态 未知）",
		],
		[
			"no period",
			reading({ account: { periodEnd: null } }),
			"读不到（接口未给账期）",
		],
		[
			"expired period",
			reading({ account: { periodEnd: "2026-09-24T07:00:00.000Z" } }),
			"读不到（读数已过期）",
		],
		[
			"period ending exactly now",
			reading({ account: { periodEnd: GENERATED_AT } }),
			"读不到（读数已过期）",
		],
	])("shows next charge for %s", (_label, store, expected) => {
		expect(live(store).nextCharge).toBe(expected);
	});

	it.each<[string, VercelAccountStore | null, string[]]>([
		["never read", null, ["读不到（尚未读取）"]],
		[
			"suspended",
			reading({
				blob: { status: "limits-exceeded-suspended", usageQuotaExceeded: true },
			}),
			[
				"超额被停",
				"已存 1.1 MB · 23 个对象",
				"本期占比：读不到（接口不给额度上限）",
			],
		],
		[
			"over quota",
			reading({ blob: { usageQuotaExceeded: true } }),
			[
				"已超额",
				"已存 1.1 MB · 23 个对象",
				"本期占比：读不到（接口不给额度上限）",
			],
		],
		[
			"other status",
			reading({ blob: { status: "provisioning" } }),
			[
				"状态 provisioning",
				"已存 1.1 MB · 23 个对象",
				"本期占比：读不到（接口不给额度上限）",
			],
		],
		[
			"owner mismatch",
			failed(null, "owner_mismatch"),
			["读不到（store 不在这个号）"],
		],
		[
			"no binding",
			failed(null, "no_store_binding"),
			["读不到（报告托管未绑定 store）"],
		],
		[
			"registry",
			failed(null, "registry_unreadable"),
			["读不到（托管注册表读不到）"],
		],
		["network", failed("network", "network"), ["读不到（接口未返回）"]],
		["deadline", failed(null, "deadline"), ["读不到（本轮超时）"]],
	])("shows Blob lines for %s", (_label, store, expected) => {
		expect(live(store).blobLines).toEqual(expected);
	});

	it("is in use only with both the account and its owned store", () => {
		expect(live(reading()).active).toBe(true);
		expect(live(failed(null, "owner_mismatch")).active).toBe(false);
		expect(live(failed("unauthorized", "unauthorized")).active).toBe(false);
		expect(live(null).active).toBe(false);
	});

	it("labels an unread account without inventing one", () => {
		expect(live(failed("unauthorized", "unauthorized"))).toEqual({
			name: "报告托管账号",
			planDisplay: "读不到（token 已失效）",
			team: null,
			active: false,
			retired: false,
			note: null,
			nextCharge: "读不到（token 已失效）",
			blobLines: ["读不到（token 已失效）"],
		});
		expect(live(null).planDisplay).toBe("读不到（尚未读取）");
		for (const [plan, display] of [
			["pro", "Pro"],
			["hobby", "Hobby"],
			["enterprise", "Enterprise"],
			["plus_v2", "plus_v2"],
		]) {
			expect(live(reading({ account: { plan } })).planDisplay).toBe(display);
		}
	});

	it("never throws: a broken reading degrades to a fixed reason", () => {
		const broken = reading({ account: { periodEnd: "not-a-date" } });
		const section = buildVercelQuotaSection(broken, {
			generatedAt: GENERATED_AT,
			claudeEmails: emails,
		});
		expect(section.rows[0]).toMatchObject({
			name: "报告托管账号",
			active: false,
			nextCharge: "读不到（接口返回格式不对）",
		});
		expect(section.rows[1]!.name).toBe("personal2");
	});

	it("formats decimal sizes", () => {
		expect(formatVercelBytes(0)).toBe("0 KB");
		expect(formatVercelBytes(999)).toBe("1 KB");
		expect(formatVercelBytes(999_499)).toBe("999 KB");
		expect(formatVercelBytes(1_000_000)).toBe("1.0 MB");
		expect(formatVercelBytes(1_051_925)).toBe("1.1 MB");
		expect(formatVercelBytes(999_949_999)).toBe("999.9 MB");
		expect(formatVercelBytes(1_000_000_000)).toBe("1.00 GB");
		expect(formatVercelBytes(5_432_100_000)).toBe("5.43 GB");
	});
});
