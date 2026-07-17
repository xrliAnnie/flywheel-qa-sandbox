const cfg = await import(
	"/Users/xiaorongli/Dev/flywheel-FLY-1319/packages/config/dist/src/index.js"
).catch(
	() =>
		import(
			"/Users/xiaorongli/Dev/flywheel-FLY-1319/packages/config/dist/index.js"
		),
);
const { createFounderTimezoneResolver } = cfg;
let p = 0,
	f = 0;
const ok = (m) => {
	console.log(`  PASS - ${m}`);
	p++;
};
const no = (m) => {
	console.log(`  FAIL - ${m}`);
	f++;
};

// ① resolver 解析顺序:env > host readlink > Intl > LA
const mk = (o) =>
	createFounderTimezoneResolver({
		env: {},
		readlinkSync: () => "/var/db/timezone/zoneinfo/America/Los_Angeles",
		nowMs: () => 0,
		intlTimezone: () => "America/Los_Angeles",
		warn: () => {},
		...o,
	});

mk({ env: { FLYWHEEL_FOUNDER_TZ: "Asia/Tokyo" } }).resolveFounderTimezone() ===
"Asia/Tokyo"
	? ok("①-1 env 显式 IANA 赢过 host")
	: no("①-1 env 没赢");

mk({
	readlinkSync: () => "/usr/share/zoneinfo/Europe/Berlin",
}).resolveFounderTimezone() === "Europe/Berlin"
	? ok("①-2 无 env → auto=host readlink (Berlin)")
	: no("①-2 host readlink 没生效");

// 漏测层:readlink 抛错 → Intl 兜底(不能直接掉到 LA)
mk({
	readlinkSync: () => {
		throw new Error("ENOENT");
	},
	intlTimezone: () => "Asia/Tokyo",
}).resolveFounderTimezone() === "Asia/Tokyo"
	? ok("①-3 readlink 失败 → Intl 兜底 (Tokyo,不是直接 LA)")
	: no("①-3 Intl 兜底层没生效");

// 最终兜底 LA
mk({
	readlinkSync: () => {
		throw new Error("x");
	},
	intlTimezone: () => undefined,
}).resolveFounderTimezone() === "America/Los_Angeles"
	? ok("①-4 全失败 → 兜底 LA")
	: no("①-4 兜底 LA 没生效");

// ①-5 阳性对照:设错值必须被拒(证明校验是活的)
const warns = [];
const r5 = mk({
	env: { FLYWHEEL_FOUNDER_TZ: "Not/AZone" },
	warn: (m) => warns.push(m),
});
r5.resolveFounderTimezone() === "America/Los_Angeles" && warns.length === 1
	? ok("①-5 阳性对照:非法 env 被拒 + warn 一次 → 降级 host")
	: no(`①-5 非法 env 没被拒/没 warn: ${warns.length}`);

// ③ 字节兼容 A: founderMsgClock 显式 tz
const da = await import(
	"/Users/xiaorongli/Dev/flywheel-FLY-1319/packages/teamlead/dist/bridge/approval-signal/deferred-approval.js"
);
const msgId = "1394000000000000000";
const before = da.founderMsgClock(msgId, "America/Los_Angeles");
const flipped = da.founderMsgClock(msgId, "Asia/Tokyo");
/^\d{2}:\d{2}$/.test(before)
	? ok(`③-A founderMsgClock 显式 LA 仍是 HH:MM 老形态 (${before})`)
	: no(`③-A 形态变了: ${before}`);
before !== flipped
	? ok(
			"③-A 阳性对照:换 tz 会变 (" +
				before +
				" vs " +
				flipped +
				") → 尺子是活的",
		)
	: no("③-A 换 tz 不变 = 尺子坏了");

// ③ 字节兼容 B: DIGEST_TZ 显式 env 仍赢(传常量字符串 → 永不跟随 host)
const ds = await import(
	"/Users/xiaorongli/Dev/flywheel-FLY-1319/packages/teamlead/dist/bridge/digest-service.js"
);
const fakeStore = {};
const svcExplicit = new ds.DigestService(fakeStore, { tz: "Asia/Tokyo" }); // 显式 env 形态
const svcProvider = new ds.DigestService(fakeStore, {
	tz: () => "America/Los_Angeles",
}); // auto provider 形态
const now = new Date("2026-07-17T05:30:00Z"); // Tokyo=14:30 7/17, LA=22:30 7/16
const dExp = svcExplicit.defaultDay(now),
	dPro = svcProvider.defaultDay(now);
dExp === "2026-07-16"
	? ok(`③-B 显式 FLYWHEEL_DIGEST_TZ=Tokyo 赢:defaultDay=${dExp}`)
	: no(`③-B 显式 tz 没赢: ${dExp}`);
dPro === "2026-07-15"
	? ok(
			"③-B provider(LA) 给出不同 civil day=" +
				dPro +
				" → 显式 env 确实压过了 auto",
		)
	: no(`③-B provider 给了 ${dPro}`);
console.log(`\nqa-1319-C: ${p} passed, ${f} failed`);
