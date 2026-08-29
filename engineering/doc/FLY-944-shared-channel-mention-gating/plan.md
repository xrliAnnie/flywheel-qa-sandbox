# FLY-944 shared 频道 lead-to-lead @-mention 不触发 — 实施计划

Issue: FLY-944 (https://linear.app/geoforge3d/issue/FLY-944/bugrouting-shared-频道-reply-gating-漏掉-lead-to-lead-mention-只有-founder)
日期: 2026-07-06
基于: research.md

> **For agentic workers:** 本计划由三段式 pipeline 的 Implement 阶段在**同一分支**上执行,
> TDD(RED→GREEN→REFACTOR),按 Task 顺序做、频繁 commit。

**Goal**:shared 频道(每个项目的 core room + #leads-roundtable)里,任何作者(founder 或
同伴 lead bot)的真 `<@id>` @-mention 都能触发目标 Claude Lead;非 @ 消息的 FLY-152/898 回复
纪律原样保留。

**Founder spec(Annie 定稿,2026-07-06 经 Tadashi 转达,本计划逐条对上)**:
退役发信人白名单(allowFrom),规则只两条 —— ① lead 被 @ 了就回(任何人 @,含别的 lead);
② founder 发消息没 @ 人 → core 里 CoS(Cass)回。不要白名单概念,**全部 Flywheel 管理的
project 统一**。(原 ship 步骤 2 的"向 Annie 通报 FLY-898 行为收紧"就此解决 —— 该行为现在
是她亲自定的规则 ②;ship 通报改为确认落地即可。)

**Architecture**(brainstorm gate 已批,方案 A;Codex design review R1 修订):职责归位 ——
sender 信任只留 intake `allowBots`(FLY-282 自愈)+ guild 成员身份;"该不该回"只留 FLY-898
mention 纪律;shared 频道 group 的 per-group `allowFrom`(真根因,在 mention 判定之前硬丢非
白名单 bot)**退役清空**。零插件代码改动;全部落在 FLY-898 的既有脚本/CLI/启动位点上。
access.json 热生效(插件每消息 fresh loadAccess,server.ts:674)→ fleet 清扫零重启。

**核心安全不变量(Codex R1 #1/#2,全计划贯彻)**:**非-CoS core group 的 allowFrom 只允许
由"同时 flip requireMention:true (+ mentionPatterns:[]) 的主 transform"清掉**,任何路径都
不得单独清 —— 否则热生效会立刻打开"非-CoS lead 听到 core 全部消息"的 pile-on 窗口。
`--allowfrom-only` 只用于两类**角色已判定**的目标:CoS 的 core group(requireMention:false
是设计态)与 roundtable group(全 fleet 均 requireMention:true,且插件对缺省字段默认 true)。

**Tech Stack**:bash(jq,原子写 + 乐观 rebase,全部复用 FLY-898 骨架;macOS bash 3.2 约束)、
TypeScript(core-room-gate-cli 小扩展)、bash 测试(apply-core-room-mention-gate.test.sh)+ vitest。

**版本**:ship 时取空号(暂定 v1.58.x;doc/VERSION 以 ship 当刻为准)。

---

## File Structure(全部改动一览)

| 文件 | 动作 | 职责 |
|---|---|---|
| packages/teamlead/src/core-room-gate-cli.ts | Modify | 新增 `--all-leads` 模式:每个 lead 一行 JSONL {projectName, leadId, coreChannelId, isCoS, gateNonCoS, backend} |
| packages/teamlead/src/__tests__/core-room-gate-all-leads.test.ts | Create | `computeAllLeadEntries` 单测 |
| packages/teamlead/scripts/apply-core-room-mention-gate.sh | Modify | ① 核心 transform 追加清 allowFrom;② 新 `--allowfrom-only` 模式;③ 新 `--all-shared` fleet 清扫(per-lead 角色感知) |
| packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh | Modify | 更新 T1/T3 语义 + 新 T12-T18 |
| packages/teamlead/scripts/claude-lead.sh | Modify | FLY-898 块内(同作用域、同守卫)追加 FLY-944 调用:CoS-core allowfrom-only + roundtable allowfrom-only;CLI 不可用则 core **fail-closed 跳过** |
| engineering/doc/FLY-944-shared-channel-mention-gating/* | 本设计文档随分支合入 | —— |

**刻意的语义变化(已获批)**:apply_one 对目标 core group 的 patch 现在包含
`allowFrom = []`。旧测试 T3"core group 的 allowFrom 不动"断言按新语义更新为"core group 的
allowFrom 被清空、**其余一切字段/组 canonical 不变**"。顶层 allowFrom(DM 配对)、allowBots、
dmPolicy、非 shared group 保持**语义/canonical(jq -S 指纹)不变**(Codex R1 #3:脚本经 jq
全量重写文件,保证的是 canonical 等价而非逐字节;现有测试的 rest_fingerprint 断言即此口径,沿用)。

---

## Task 1: core-room-gate-cli 新增 `--all-leads`(per-lead 角色枚举)

fleet 清扫需要**每个 lead** 的 {core id, isCoS, gateNonCoS, backend} 才能安全分流
(Codex R1 #1:只枚举去重 core id 会丢失 CoS/非-CoS 区分)。

**Files:**
- Modify: `packages/teamlead/src/core-room-gate-cli.ts`
- Create: `packages/teamlead/src/__tests__/core-room-gate-all-leads.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/teamlead/src/__tests__/core-room-gate-all-leads.test.ts
import { describe, expect, it } from "vitest";
import { computeAllLeadEntries } from "../core-room-gate-cli.js";

describe("computeAllLeadEntries (FLY-944)", () => {
	const projects = [
		{
			projectName: "flywheel",
			generalChannel: "core-1",
			leads: [
				{ agentId: "cos", chatChannel: "core-1" },
				{ agentId: "eng", chatChannel: "chat-eng" },
				{ agentId: "mufasa", chatChannel: "chat-m", backend: "codex-app-server" },
			],
		},
		{
			// no core → no gate, still enumerated (roundtable sweep needs the lead)
			projectName: "coreless",
			leads: [{ agentId: "solo", chatChannel: "chat-s" }],
		},
	];

	it("emits one entry per lead with role flags", () => {
		expect(computeAllLeadEntries(projects as never)).toEqual([
			{ projectName: "flywheel", leadId: "cos", coreChannelId: "core-1", isCoS: true, gateNonCoS: false, backend: "claude-code" },
			{ projectName: "flywheel", leadId: "eng", coreChannelId: "core-1", isCoS: false, gateNonCoS: true, backend: "claude-code" },
			{ projectName: "flywheel", leadId: "mufasa", coreChannelId: "core-1", isCoS: false, gateNonCoS: true, backend: "codex-app-server" },
			{ projectName: "coreless", leadId: "solo", coreChannelId: undefined, isCoS: false, gateNonCoS: false, backend: "claude-code" },
		]);
	});
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `pnpm -F flywheel-teamlead vitest run src/__tests__/core-room-gate-all-leads.test.ts`
Expected: FAIL —— `computeAllLeadEntries` 未导出。

- [ ] **Step 3: 最小实现**

`core-room-gate-cli.ts`(`computeAllGates` 之后)新增:

```ts
export interface LeadEntry {
	projectName: string;
	leadId: string;
	coreChannelId: string | undefined;
	isCoS: boolean;
	gateNonCoS: boolean;
	backend: GateEntry["backend"];
}

/** FLY-944 — one entry per lead across the fleet with role flags. Drives the
 * shared-channel allowFrom sweep (apply-core-room-mention-gate.sh --all-shared):
 * a NON-CoS core may only lose allowFrom via the main transform that also flips
 * requireMention (pile-on guard), while a CoS core / roundtable group is safe
 * for --allowfrom-only. The sweep needs isCoS/gateNonCoS per lead, not just the
 * channel set. */
export function computeAllLeadEntries(projects: ProjectLike[]): LeadEntry[] {
	const out: LeadEntry[] = [];
	for (const p of projects) {
		for (const lead of p.leads ?? []) {
			const g = resolveCoreRoomGate(p, lead);
			out.push({
				projectName: p.projectName,
				leadId: lead.agentId,
				coreChannelId: g.coreChannelId,
				isCoS: g.isCoS,
				gateNonCoS: g.gateNonCoS,
				backend: backendOf(lead),
			});
		}
	}
	return out;
}
```

main() 里 `--all` 分支之前加:

```ts
	if (process.argv.includes("--all-leads")) {
		for (const e of computeAllLeadEntries(projects)) {
			process.stdout.write(`${JSON.stringify(e)}\n`);
		}
		return;
	}
```

并把文件头注释的"Two modes"更新为三种模式(补 `--all-leads` 一行说明)。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `pnpm -F flywheel-teamlead vitest run src/__tests__/core-room-gate-all-leads.test.ts`
Expected: PASS。

- [ ] **Step 5: build + commit**

```bash
pnpm -F flywheel-teamlead build
git add packages/teamlead/src/core-room-gate-cli.ts packages/teamlead/src/__tests__/core-room-gate-all-leads.test.ts
git commit -m "feat(FLY-944): core-room-gate-cli --all-leads — per-lead role entries for shared sweep"
```

---

## Task 2: apply_one 新增 `--allowfrom-only` 模式

只清目标 group 的 `allowFrom`,不碰 requireMention/mentionPatterns。**调用方合同**:只可
用于 CoS core group 与 roundtable group(角色判定在调用方 —— Task 4 的 per-lead 分流与
Task 5 的 launcher 守卫);非-CoS core 走主 transform(Task 3)。

**Files:**
- Modify: `packages/teamlead/scripts/apply-core-room-mention-gate.sh`
- Modify: `packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`

- [ ] **Step 1: 写失败测试(追加到测试文件尾部,T11 之后、汇总输出之前)**

```bash
# ── T12: --allowfrom-only clears ONLY allowFrom on the target group ─────────
log_test "T12 --allowfrom-only clears allowFrom, leaves requireMention/mentionPatterns/others"
A="$TMP_DIR/t12.json"; make_access "$A"
BEFORE_REST="$(rest_fingerprint "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] \
  && [ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" = "0" ] \
  && [ "$(jq -r ".groups[\"$CORE\"].requireMention" "$A")" = "false" ] \
  && [ "$(jq -r ".groups[\"$CORE\"] | has(\"mentionPatterns\")" "$A")" = "false" ] \
  && [ "$(rest_fingerprint "$A")" = "$BEFORE_REST" ]; then
  log_pass "allowFrom cleared, requireMention/mentionPatterns untouched, rest identical"
else
  log_fail "T12 wrong result (rc=$rc): $(jq -c ".groups[\"$CORE\"]" "$A")"
fi

# ── T13: --allowfrom-only idempotent ────────────────────────────────────────
log_test "T13 --allowfrom-only re-run at target state is a no-op"
BEFORE_ALL="$(jq -S . "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$A")" = "$BEFORE_ALL" ]; then
  log_pass "idempotent no-op"
else
  log_fail "T13 re-run changed file or failed (rc=$rc)"
fi

# ── T14: --allowfrom-only absent group → no-op, never creates ───────────────
log_test "T14 --allowfrom-only on absent group is a no-op"
A="$TMP_DIR/t14.json"; make_access "$A"
BEFORE_ALL="$(jq -S . "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "9999999" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$A")" = "$BEFORE_ALL" ]; then
  log_pass "absent group untouched, exit 0"
else
  log_fail "T14 mutated file or failed (rc=$rc)"
fi
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`
Expected: T12-T14 FAIL(unknown arg '--allowfrom-only',exit 2)。

- [ ] **Step 3: 实现**

`apply-core-room-mention-gate.sh` 改动三处:

(a) 参数解析(while-case 里加一行,并同步 usage() 文本):

```bash
    --allowfrom-only) ALLOWFROM_ONLY=1; shift ;;
```

以及初始化区 `ID_ONLY=0` 旁:

```bash
ALLOWFROM_ONLY=0
```

(b) apply_one() 的"当前态/目标态"判定与 transform 支持第三种模式 —— 在
`want_id_only` 决策块之后插入 allowfrom-only 短路(整个模式独立,最小侵入):

```bash
  # ── FLY-944 --allowfrom-only: retire the per-group sender whitelist ONLY ──
  # CALLER CONTRACT: only for a CoS core group (requireMention:false is its
  # design state) or a roundtable group (fleet-wide requireMention:true; the
  # plugin also defaults a MISSING requireMention to true). A NON-CoS core must
  # go through the main transform (flip + clear together) — clearing allowFrom
  # alone there would open the hear-everything pile-on window (hot-reload!).
  if [ "$ALLOWFROM_ONLY" -eq 1 ]; then
    local cur_af_empty
    cur_af_empty=$(jq -r --arg ch "$ch" \
      '((.groups[$ch].allowFrom // []) | length) == 0' "$af")
    if [ "$cur_af_empty" = "true" ]; then
      log "group '$ch' allowFrom already empty in $af — no-op"
      return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      log "DRY-RUN — would clear group '$ch' allowFrom in $af"
      return 0
    fi
    atomic_patch "$af" "$ch" '.groups[$ch].allowFrom = []' \
      "group '$ch' → allowFrom:[] (shared-channel sender whitelist retired)"
    return $?
  fi
```

(c) 把现有"原子写 + 乐观 rebase 5 重试"循环抽成可复用函数 `atomic_patch <file> <ch>
<jq-filter> <log-msg>`(现循环体几乎原样搬入,jq 调用变为
`jq --arg ch "$ch" "$filter"`),原 id-only / 非-id-only 两分支改为拼 filter 字符串后调
`atomic_patch`。抽取时保持:备份、pre-hash rebase、坏 JSON fail-closed、5 次重试、
swapped 检查全部原样。注意 macOS bash 3.2:函数内 `local`、无关联数组、无 `${var,,}`。

- [ ] **Step 4: 跑测试确认 GREEN(全套,含 T1-T11 回归)**

Run: `bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`
Expected: 全 PASS(T1-T14)。

- [ ] **Step 5: shellcheck + commit**

```bash
shellcheck packages/teamlead/scripts/apply-core-room-mention-gate.sh
git add packages/teamlead/scripts/apply-core-room-mention-gate.sh packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
git commit -m "feat(FLY-944): apply-core-room-mention-gate --allowfrom-only mode + atomic_patch extraction"
```

---

## Task 3: 核心 transform 追加清 allowFrom(非-CoS core group)

非-CoS core 的 allowFrom **只能**在这里(与 requireMention flip 同一个原子 patch)被清 ——
这是本计划的核心安全不变量。

**Files:**
- Modify: `packages/teamlead/scripts/apply-core-room-mention-gate.sh`
- Modify: `packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`

- [ ] **Step 1: 更新测试期望(RED)**

T1 增加断言(id-only 结果同时 allowFrom 为空):

```bash
# T1 断言追加(在现有 requireMention/mentionPatterns 断言的 && 链上):
  && [ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" = "0" ] \
```

T3 语义更新:断言从"core group 的 allowFrom 不动"改为"core group 的 allowFrom 被清空;
**除 core group 外的一切**(allowBots、dmPolicy、顶层 allowFrom、$OTHER group 含其
allowFrom、全局 mentionPatterns、pending)canonical 指纹不变"——T3 本来就用
rest_fingerprint(del core group)对比,只需删掉/反转其中"core allowFrom 保持 ['annie']"
的那条子断言。T2(幂等)自然覆盖:目标态判定加入 allowFrom 为空(见 Step 3),已在目标态
的文件重跑不变。另补一条:

```bash
# ── T15: 已 flip 但 allowFrom 未清的存量(FLY-898 旧目标态)会被补清 ─────────
log_test "T15 legacy FLY-898 target-state (requireMention:true, allowFrom non-empty) gets allowFrom cleared"
A="$TMP_DIR/t15.json"; make_access "$A"
jq ".groups[\"$CORE\"].requireMention = true | .groups[\"$CORE\"].mentionPatterns = []" "$A" > "$A.tmp" && mv "$A.tmp" "$A"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --id-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" = "0" ]; then
  log_pass "legacy flipped group still gets allowFrom cleared"
else
  log_fail "T15 allowFrom not cleared (rc=$rc): $(jq -c ".groups[\"$CORE\"]" "$A")"
fi
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`
Expected: T1/T3/T15 FAIL(allowFrom 仍是 ["annie"])。

- [ ] **Step 3: 实现**

apply_one() 主路径(非 allowfrom-only):

- 当前态检测加一项:

```bash
  local cur_af_empty
  cur_af_empty=$(jq -r --arg ch "$ch" \
    '((.groups[$ch].allowFrom // []) | length) == 0' "$af")
```

- 幂等目标态条件从 `cur_req == true && (…patterns…)` 扩为再 `&& [ "$cur_af_empty" = "true" ]`;
- 两个 transform filter 各追加 ` | .groups[$ch].allowFrom = []`;
- DRY-RUN 与成功日志文案追加 `+ allowFrom:[]` 字样;
- 文件头 WHY/WHAT 注释补 FLY-944 一段(allowFrom 在 mention 判定之前硬丢同伴 lead 的真 @,
  故随 flip 一并退役;非-CoS core 的清空必须与 flip 同一个原子 patch)。

- [ ] **Step 4: 跑测试确认 GREEN(T1-T15 全过)**

Run: `bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`
Expected: 全 PASS。

- [ ] **Step 5: commit**

```bash
git add packages/teamlead/scripts/apply-core-room-mention-gate.sh packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
git commit -m "fix(FLY-944): core-group patch also retires allowFrom (pre-mention sender whitelist)"
```

---

## Task 4: `--all-shared` fleet 清扫模式(per-lead 角色感知)

对 fleet 每个 **Claude** lead(来自 `--all-leads` 的 projects.json roster):
- `gateNonCoS=true` 的 core group → **主 transform `--id-only`**(flip + patterns + 清
  allowFrom,一个原子 patch —— 绝不 allowfrom-only);
- `isCoS=true` 的 core group → `--allowfrom-only`;
- 每个 lead 的 roundtable group → `--allowfrom-only`。
覆盖不走 claude-lead.sh 的存量(Belle 等 companion lead,在 projects.json roster 内)。
不在 roster 里的遗留目录(discord-peter 旧目录等)不触碰。

**Files:**
- Modify: `packages/teamlead/scripts/apply-core-room-mention-gate.sh`
- Modify: `packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`

- [ ] **Step 1: 写失败测试**

```bash
# ── T16: --all-shared per-lead 分流:非-CoS core 走主 transform,CoS core / roundtable 只清 allowFrom ─
log_test "T16 --all-shared sweeps by role: non-CoS core flips+clears, CoS core & roundtable clear-only"
FLEET_DIR="$TMP_DIR/channels16"; mkdir -p "$FLEET_DIR/discord-cos" "$FLEET_DIR/discord-eng"
RT="1512578695468941333"
cat > "$TMP_DIR/roundtable16.json" <<JSON
{ "channelId": "$RT" }
JSON
# cos(CoS): core requireMention:false 带白名单(设计态,只清 allowFrom)+ roundtable 带白名单
cat > "$FLEET_DIR/discord-cos/access.json" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "allowBots": ["b1"],
  "groups": {
    "$CORE": { "requireMention": false, "allowFrom": ["annie", "eng-bot"] },
    "$RT":   { "requireMention": true,  "allowFrom": ["annie"] }
  }, "pending": {} }
JSON
# eng(非-CoS,legacy 形态): core requireMention:false + 白名单 → 必须 flip+清一起;other 组不动
cat > "$FLEET_DIR/discord-eng/access.json" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "groups": {
    "$CORE":  { "requireMention": false, "allowFrom": ["annie", "cos-bot"] },
    "$RT":    { "requireMention": true,  "allowFrom": ["annie", "b1"] },
    "$OTHER": { "requireMention": true,  "allowFrom": ["annie"] }
  }, "pending": {} }
JSON
# 假 GATE_CLI:--all-leads 输出两行(cos=isCoS, eng=gateNonCoS)
FAKE_CLI="$TMP_DIR/fake-gate-cli-16.js"
cat > "$FAKE_CLI" <<JS
if (process.argv.includes("--all-leads")) {
  console.log(JSON.stringify({ projectName: "p", leadId: "cos", coreChannelId: "$CORE", isCoS: true,  gateNonCoS: false, backend: "claude-code" }));
  console.log(JSON.stringify({ projectName: "p", leadId: "eng", coreChannelId: "$CORE", isCoS: false, gateNonCoS: true,  backend: "claude-code" }));
}
JS
FLYWHEEL_CHANNELS_DIR="$FLEET_DIR" \
FLYWHEEL_CORE_ROOM_GATE_CLI="$FAKE_CLI" \
FLYWHEEL_ROUNDTABLE_FILE="$TMP_DIR/roundtable16.json" \
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" \
  "$SCRIPT" --all-shared >/dev/null 2>&1
rc=$?
ok=1
# eng 非-CoS core:flip + patterns + allowFrom 清空,同一次 patch(pile-on 安全不变量)
[ "$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-eng/access.json")" = "true" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].mentionPatterns | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
# cos CoS core:requireMention 保持 false,只清 allowFrom
[ "$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-cos/access.json")" = "false" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-cos/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"] | has(\"mentionPatterns\")" "$FLEET_DIR/discord-cos/access.json")" = "false" ] || ok=0
# roundtable 两边都清空、requireMention 不动
[ "$(jq -r ".groups[\"$RT\"].allowFrom | length" "$FLEET_DIR/discord-cos/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$RT\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$RT\"].requireMention" "$FLEET_DIR/discord-eng/access.json")" = "true" ] || ok=0
# other group + 顶层 allowFrom 不动
[ "$(jq -r ".groups[\"$OTHER\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "1" ] || ok=0
[ "$(jq -r ".allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "1" ] || ok=0
if [ $rc -eq 0 ] && [ $ok -eq 1 ]; then
  log_pass "role-aware sweep correct on all groups"
else
  log_fail "T16 sweep wrong (rc=$rc)"
fi

# ── T17: --all-shared --dry-run 不改任何文件 ────────────────────────────────
log_test "T17 --all-shared --dry-run mutates nothing"
jq ".groups[\"$RT\"].allowFrom = [\"annie\"]" "$FLEET_DIR/discord-eng/access.json" \
  > "$FLEET_DIR/discord-eng/access.json.tmp2" && mv "$FLEET_DIR/discord-eng/access.json.tmp2" "$FLEET_DIR/discord-eng/access.json"
BEFORE_A="$(jq -S . "$FLEET_DIR/discord-eng/access.json")"
FLYWHEEL_CHANNELS_DIR="$FLEET_DIR" \
FLYWHEEL_CORE_ROOM_GATE_CLI="$FAKE_CLI" \
FLYWHEEL_ROUNDTABLE_FILE="$TMP_DIR/roundtable16.json" \
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" \
  "$SCRIPT" --all-shared --dry-run >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$FLEET_DIR/discord-eng/access.json")" = "$BEFORE_A" ]; then
  log_pass "dry-run left files untouched"
else
  log_fail "T17 dry-run mutated file (rc=$rc)"
fi

# ── T18: 回归守卫(Codex R1 #1):--all-shared 绝不产出 requireMention:false + allowFrom:[] 的非-CoS core ─
log_test "T18 --all-shared never leaves a non-CoS core open (requireMention:false + empty allowFrom)"
req="$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-eng/access.json")"
af_len="$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")"
if [ "$req" = "true" ] || [ "$af_len" != "0" ]; then
  log_pass "non-CoS core not left open (requireMention=$req, allowFrom len=$af_len)"
else
  log_fail "T18 non-CoS core left OPEN: requireMention=false + allowFrom=[]"
fi
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`
Expected: T16-T18 FAIL(unknown arg '--all-shared')。

- [ ] **Step 3: 实现**

(a) 顶部数据源(CHANNELS_DIR 定义旁)加 roundtable 文件解析(env 优先,测试可覆盖):

```bash
# FLY-944: roundtable channel id — env wins, else the FLY-569 shared default.
ROUNDTABLE_FILE="${FLYWHEEL_ROUNDTABLE_FILE:-$HOME/.flywheel/roundtable.json}"
resolve_roundtable_id() {
  if [ -n "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}" ]; then
    printf '%s' "$FLYWHEEL_ROUNDTABLE_CHANNEL_ID"; return 0
  fi
  [ -f "$ROUNDTABLE_FILE" ] && jq -r '.channelId // empty' "$ROUNDTABLE_FILE" 2>/dev/null
}
```

(b) 参数解析加 `--all-shared) ALL_SHARED=1; shift ;;`(初始化 `ALL_SHARED=0`,usage 同步)。

(c) 新 fleet 函数(run_all 之后)。角色分流是安全核心:

```bash
# ── FLY-944 fleet mode: retire allowFrom on shared groups, role-aware ───────
# Non-CoS core → the MAIN transform (--id-only semantics: flip + patterns +
# clear in ONE atomic patch). CoS core & roundtable → --allowfrom-only.
# Never clears a non-CoS core's allowFrom without flipping requireMention.
run_all_shared() {
  if [ ! -f "$GATE_CLI" ]; then
    log "ERROR: decision CLI not built ($GATE_CLI) — run: pnpm -F flywheel-teamlead build"
    return 1
  fi
  local jsonl rt rc=0
  jsonl="$(node "$GATE_CLI" --all-leads 2>/dev/null)" || {
    log "ERROR: core-room-gate-cli --all-leads failed"; return 1
  }
  rt="$(resolve_roundtable_id || true)"
  local line backend lead core is_cos gate af
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    backend=$(printf '%s' "$line" | jq -r '.backend')
    # Codex leads gate via runtime env, not access.json — skip (mirror run_all).
    [ "$backend" = "codex-app-server" ] && continue
    lead=$(printf '%s' "$line" | jq -r '.leadId')
    core=$(printf '%s' "$line" | jq -r '.coreChannelId // empty')
    is_cos=$(printf '%s' "$line" | jq -r '.isCoS')
    gate=$(printf '%s' "$line" | jq -r '.gateNonCoS')
    af="${CHANNELS_DIR}/discord-${lead}/access.json"
    [ -f "$af" ] || continue
    if [ -n "$core" ]; then
      if [ "$gate" = "true" ]; then
        # non-CoS core: main transform ONLY (flip + patterns + clear together).
        log "all-shared ${lead}: non-CoS core ${core} → main transform (id-only)"
        ID_ONLY=1 ALLOWFROM_ONLY=0 apply_one "$af" "$core" || rc=1
      elif [ "$is_cos" = "true" ]; then
        log "all-shared ${lead}: CoS core ${core} → allowfrom-only"
        ALLOWFROM_ONLY=1 apply_one "$af" "$core" || rc=1
      fi
      # core-no-CoS project (joycon): gateNonCoS=false & isCoS=false → core untouched.
    fi
    if [ -n "$rt" ]; then
      log "all-shared ${lead}: roundtable ${rt} → allowfrom-only"
      ALLOWFROM_ONLY=1 apply_one "$af" "$rt" || rc=1
    fi
  done <<< "$jsonl"
  return $rc
}
```

注 1:`ID_ONLY=1 apply_one …` / `ALLOWFROM_ONLY=1 apply_one …` 用 bash 的命令级临时变量
覆盖函数所读全局(bash 3.2 支持对函数调用的 env-prefix 赋值;实现时若 shellcheck/行为
存疑,改为给 apply_one 加第三个显式 mode 参数,行为等价 —— 实现者二选一,测试同样覆盖)。
注 2:缺 group 的 lead 由 apply_one 的 no-op 路径自然跳过(T14 已证);"core 有但无 CoS"
项目(joycon)core 不动 —— 单 lead 项目的 core 纪律是 FLY-898 显式豁免的,不借道本清扫改变。

(d) 入口分派(现有 `if [ "$ALL" -eq 1 ]` 之前):

```bash
if [ "$ALL_SHARED" -eq 1 ]; then
  run_all_shared
  exit $?
fi
```

- [ ] **Step 4: 跑测试确认 GREEN(T1-T18 全过)+ shellcheck**

```bash
bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
shellcheck packages/teamlead/scripts/apply-core-room-mention-gate.sh
```

- [ ] **Step 5: commit**

```bash
git add packages/teamlead/scripts/apply-core-room-mention-gate.sh packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
git commit -m "feat(FLY-944): --all-shared role-aware fleet sweep — retire allowFrom on shared groups"
```

---

## Task 5: claude-lead.sh 启动自愈位点(防漂移,fail-closed)

**Codex R1 #2 修订**:FLY-944 调用放进 FLY-898 块的**同一个 if 作用域**(共享 `_cg_cli` /
`_cg_apply` / `_cg_json` 与其可用性守卫)。CLI 不可用或 gate JSON 解析失败 → **core 一律
不清**(fail-closed);roundtable 清理同样只在该守卫内执行(同一工具链,免得单独一套守卫)。
非-CoS core 在这里**不需要额外调用**:现有 FLY-898 的 `--id-only` 调用经 Task 3 已把
allowFrom 一起清了。

**Files:**
- Modify: `packages/teamlead/scripts/claude-lead.sh`(FLY-898 块内部,约 :2276-2290)

- [ ] **Step 1: 实现**

把现有块:

```bash
    if [ "$_cg_gate" = "true" ] && [ -n "$_cg_core" ]; then
      log "FLY-898: applying core-room mention gate for ${LEAD_ID} (core ${_cg_core})"
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_cg_core" --id-only || true
    fi
```

扩为:

```bash
    _cg_iscos="$(printf '%s' "$_cg_json" | jq -r '.isCoS // false' 2>/dev/null || echo false)"
    if [ "$_cg_gate" = "true" ] && [ -n "$_cg_core" ]; then
      log "FLY-898: applying core-room mention gate for ${LEAD_ID} (core ${_cg_core})"
      # FLY-944: the --id-only transform now ALSO clears the group's allowFrom
      # (sender whitelist retired in the same atomic patch — pile-on safe).
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_cg_core" --id-only || true
    elif [ "$_cg_iscos" = "true" ] && [ -n "$_cg_core" ]; then
      # FLY-944: a CoS keeps requireMention:false (it must hear its whole core)
      # but its stale allowFrom whitelist made it deaf to NEW sibling leads
      # (Cass missing HL). Clear allowFrom only.
      log "FLY-944: clearing CoS core allowFrom for ${LEAD_ID} (core ${_cg_core})"
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_cg_core" --allowfrom-only || true
    fi
    # FLY-944: roundtable sender whitelist retired for every lead (discipline
    # there is requireMention:true fleet-wide; plugin defaults a missing field
    # to true). Same guarded scope → same fail-closed behavior as core.
    _f944_rt=""
    if [ -n "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}" ]; then
      _f944_rt="$FLYWHEEL_ROUNDTABLE_CHANNEL_ID"
    elif [ -f "${HOME}/.flywheel/roundtable.json" ]; then
      _f944_rt="$(jq -r '.channelId // empty' "${HOME}/.flywheel/roundtable.json" 2>/dev/null || true)"
    fi
    if [ -n "$_f944_rt" ]; then
      log "FLY-944: clearing roundtable allowFrom for ${LEAD_ID} (channel ${_f944_rt})"
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_f944_rt" --allowfrom-only || true
    fi
```

(块外的 `else log "FLY-898: core-room-gate CLI/helper not built or jq missing — skip"`
分支不变 —— CLI 不可用时 core 与 roundtable 都不动,fail-closed。)

- [ ] **Step 2: 验证(语法 + 完整 shellcheck,不过滤)**

```bash
bash -n packages/teamlead/scripts/claude-lead.sh
shellcheck packages/teamlead/scripts/claude-lead.sh
```

完整跑 shellcheck(Codex R1 #4:不许 grep 过滤);若有**既有**告警,在 PR 描述里单独列出
"pre-existing, untouched",新增代码必须零新告警。

```bash
bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
pnpm -F flywheel-teamlead vitest run
```

- [ ] **Step 3: commit**

```bash
git add packages/teamlead/scripts/claude-lead.sh
git commit -m "feat(FLY-944): launch-time self-heal — CoS core + roundtable allowFrom retirement (fail-closed)"
```

---

## Task 6: 全仓校验 + PR

- [ ] **Step 1: 全仓 lint + teamlead 测试套件**

```bash
pnpm lint
pnpm -F flywheel-teamlead build && pnpm -F flywheel-teamlead vitest run
bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh
```

Expected: 全绿。

- [ ] **Step 2: push + PR(英文 body,含 Linear Issue 段 + 本设计文档链接)+ `flywheel-comm stage set pr_created`**

PR 要点:root cause(allowFrom 先于 mention 判定)、方案 A 职责归位表、核心安全不变量
(非-CoS core 只能 flip+清一体)、刻意语义变化(T3 断言更新理由)、canonical(非逐字节)
保持口径、热生效(零重启)、fleet sweep 是 ship 步骤非代码路径。

---

## Ship / 部署步骤(implement 阶段之后,founder-gated)

1. PR merge 后在生产 main checkout 执行存量清扫。**顺序是安全的一部分**(Codex R1 #1):
   先 `--all --id-only`(把所有非-CoS core 一次性 flip+清,含 Tadashi 的存量),**成功后**
   才 `--all-shared`(补 CoS core + roundtable;此时非-CoS core 已是目标态,role-aware
   分流再兜一层)。每步先 dry-run 给 Tadashi 看输出:

```bash
node packages/teamlead/dist/core-room-gate-cli.js --all-leads   # 肉眼核对 roster/角色
bash packages/teamlead/scripts/apply-core-room-mention-gate.sh --all --id-only --dry-run \
  && bash packages/teamlead/scripts/apply-core-room-mention-gate.sh --all --id-only \
  && bash packages/teamlead/scripts/apply-core-room-mention-gate.sh --all-shared --dry-run \
  && bash packages/teamlead/scripts/apply-core-room-mention-gate.sh --all-shared
```

   任何一步非零退出 → 停,不继续(`&&` 链保证)。**热生效,零 Lead/Bridge 重启**(插件每
   消息 fresh loadAccess)。
2. **向 Annie 显式通报行为变化**(brainstorm gate 已确认要说):Tadashi 被 flip 后,
   founder 在 core 的无 @ 消息只有 CoS 回(FLY-898 她自定的语义,当晚"founder 说话
   Tadashi 就回"是因为他还没被 flip)。
3. QA(独立 session,真机 N-to-N,验收口径 = research.md §6):
   - HL ↔ Tadashi 在 #flywheel-core 双向真 @ → 双方都触发并回复(复刻 FSM 场景);
   - 同对在 #leads-roundtable 双向真 @ → 触发;
   - core 无 @ 消息 → 只有 Cass 反应(含验证 Tadashi 被 flip 后不再响应无 @ 消息);
   - roundtable 无 @ → 无关 lead 不反应;
   - Cass 在 core 能听见 HL;Belle 在 roundtable 被新 lead @ 能触发;
   - normalize 重跑 diff 为空(幂等);非目标 group canonical 指纹不变。

## 回滚

- 每次 patch 自带时间戳 `.bak`(脚本既有机制);恢复 = 拷回 .bak(同样热生效)。
- 语义回滚 = revert PR + 拷回 .bak;无状态迁移、无 schema、无重启依赖。

## 明确不做(YAGNI)

- 不改插件 fork 代码(gate 顺序、isMentioned、FLY-314 政策全不动);
- 不动 Codex 入站(无 allowFrom 概念,research §3 已核验为通);
- 不动顶层 allowFrom(DM 配对)/ dmPolicy / allowBots;
- 不动"core 有但无 CoS"项目(joycon)的 core group(FLY-898 显式豁免,单 lead 不被静音);
- 不给 anna(external-locked)做额外可达性设计(现状已是 allowFrom:[],不变);
- 不做"per-channel sender 白名单"的替代品 —— 该需求若真出现,走 allowBots/权限层。
