// FLY-980 V10 — subscription usage 快照(每步前后各跑一次,差值=该步消耗)。
// credits 池 = character_count/limit;Agents 分钟池字段以真机返回为准
// (research §3: 分钟池独立于 credits,本脚本把 subscription 原样落盘取证)。
// usage: node usage.mjs [label]
import { mkdirSync, writeFileSync } from "node:fs";
import { xi } from "./lib/eleven.mjs";

const label = process.argv[2] ?? "snapshot";
const sub = await xi("/v1/user/subscription");
mkdirSync("out", { recursive: true });
const file = `out/usage-${label}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(sub, null, 2));
console.log(
	JSON.stringify(
		{
			tier: sub.tier,
			character_count: sub.character_count,
			character_limit: sub.character_limit,
			convai_chars: sub.convai_characters_per_minute ?? null,
			next_reset_ts: sub.next_character_count_reset_unix,
		},
		null,
		2,
	),
);
console.log(`raw → ${file}`);
