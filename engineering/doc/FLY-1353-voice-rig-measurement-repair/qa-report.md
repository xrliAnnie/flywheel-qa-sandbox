# FLY-1353 voice-rig 测量基建修缮 — QA 报告

Issue: FLY-1353 (https://linear.app/geoforge3d/issue/FLY-1353)
日期: 2026-07-17
基于: plan.md / research.md / exploration.md(同文件夹)+ 实现 head `cbdfd17e8`(PR #635)

> 三段式 QA 阶段(Design→Implement→QA,同分支)。本阶段**不重实现**;独立核对实现
> 对齐 plan、跑测试、突变验证防空绿、跑 lint,记录发现。

## Verdict 摘要

| 交付物 | 结论 | 依据 |
|--------|------|------|
| ① presence QA seam(wiring.ts + registry) | ✅ PASS | 单测全绿 + **两次突变验证**(非空绿)+ drift forward/reverse 绿 |
| ② rig config 化(rig-config.mjs + 两 rig) | ✅ PASS | rig-config 单测(字段进 config)+ 两 rig 真 import 断言 + node --check |
| ③ pack §4.2/§0 更正 | ✅ PASS(Lead 裁定后) | **更正内容正确**;交付方式(整份 pack 折进本 PR)经 Tadashi 权威裁定明确批准 |

**整体 QA verdict = PASS**。①② 技术上完全通过;③ 的更正内容正确,交付方式(整份
FLY-1347 pack 折进本 PR、不等 1347 merge)经 Lead 于 2026-07-17 权威裁定
(comm response 91a2f99a / instruction 40a66661)明确批准 ——「三件事一单修完」不变,
「文件来自 1347 分支」不作为 FAIL 理由。故 §4 的「阻塞」已解除,记录如下作留痕。

## 1. 跑过的验证(实证)

- `pnpm --filter flywheel-config test` → **447 passed**(含 `feature-flags-drift`
  forward+reverse:reverse 会真读 wiring.ts 确认 env var 名存在 —— FLY-1329 硬要求)。
- `pnpm --filter flywheel-voice-bridge test` → **673 passed**(含新
  `assistant-wiring` presence QA seam 30 测、`rig-config` 4 测,以及既有
  `qa-fly967-round3-presence` / `round5-connect` / `assistant-session` 原样绿)。
- Biome `check`(仓库 pin **2.1.4**,非 npx 漂移版本)→ `packages/voice-bridge`
  + `packages/config` 共 178 文件 **No fixes**;8 个改动文件单独 check 亦绿。

## 2. 突变验证(防「空过绿测」,MEMORY 反复咬到的失效模式)

对 `wiring.ts` 做两次受控突变、跑 presence 块、看断言**真的红**,再还原:

1. **seam 钉死 `qaPresenceOverride = false`** → `assistant-wiring` **8 failed** =
   1 正向(override="1" 进 live)+ 7 守卫(全部 reject 用例)。sentinel + 窄解析
   ("0"/"true"/"") 保持绿(与 seam-off 行为一致)。→ 证明正向用例真依赖 seam 短路。
2. **守卫禁用 `if (!stagedBridge && stagedBridge)`** → 正好 **7 failed** = 7 条守卫
   reject 用例;sentinel/正向/窄解析全绿。→ 证明 7 条守卫真依赖 URL allowlist 逻辑,
   不是空过。

两次突变后均 `git checkout` 还原,工作树干净(commit 前核过)。

## 3. 代码对齐 plan 的核对

- seam 是**窄布尔**:一个 `const` + 两分支 + 一个 staged-identity allowlist 守卫;
  unset(或 !== "1")= 字节级零行为变化;armed + 非 `http://127.0.0.1:9877` = boot 拒启。
  符合 plan「不做通用 hook」(FLY-1323 前车)。
- registry 条目 `voice_qa_presence_override` 带**真实 readSites**(wiring.ts
  `wireAssistantMode` env-param),`toggleable: readonly` + QA-only note。drift 双向绿。
- rig-config `buildStagedConfig` 补齐 7 个 boot-read 字段;`bargeInMinRms: 0` 注释
  明确是 measurement-rig override(非 loader parity),与 plan §4 一致;两 rig 均加
  `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1"`(可被负向对照 =0 覆盖)。

## 4. 阻塞发现 — pack 交付方式违反 plan Step 5

**事实(逐条实证):**
- `origin/main` 上**不存在** `engineering/doc/FLY-1347-voice-measurement-pack/`
  文件夹(`git cat-file -e origin/main:.../voice-measurement-pack.md` → 不存在)。
- 本分支 feature commit `9676969d4` 把该 pack 作 **284 行纯新增**建入。
- 与 `origin/flywheel-FLY-1347` 分支的 pack 逐字 diff = **正好两处预期更正**
  (§0 表 /gemini 行加 seam 条件 + 负向对照;§4.2 `INJECTOR_BOT_TOKEN` pool-05→
  pool-06 + 自撞说明)—— 即:**把未合入 main 的 FLY-1347 整份 pack 复制进了本分支**。
- `flywheel-FLY-1347` 分支领先 main 4 个 commit,**尚未开 PR、未合并**。
- comm.db 无任何 Lead 批准「并单」的记录。

**为什么这是问题(plan Step 5 逐字预警的正是此):**
1. **必撞 add/add 冲突**:#635 先合 → main 拿到整份 pack → FLY-1347 日后 PR 冲突;
   反之 FLY-1347 先合 → #635 冲突。plan Step 5 的硬前置(FLY-1347 先上 main + 就地
   改)就是为规避此;明文写「**不复制 pack 文件夹进本分支(必撞冲突)**」。
2. **范围外交付**:#635 的 284 行里只有约 4 行(两 hunk)是 FLY-1353 真正的 pack
   更正,其余是 FLY-1347 的**整份**交付物。等于 1353 顺带交付了 1347 的活。
3. plan Step 5 要求 pack 不在 main 时**停下 `flywheel-comm ask` 问 Lead 二选一**
   (a 先 merge 1347 / b 明确重批拆单)。此决定被跳过,无 Lead 记录。

> 注:PR #635 正文第 3 点**透明写明**「carry the authoritative FLY-1347 pack into
> this PR」—— 实现者未隐瞒,是刻意选择;但透明不消解冲突/范围事实,且 plan 明令此决定
> 归 Lead。

**这不是代码缺陷**,是交付排序/范围决定,plan 本身把它路由给 Lead。QA 就此向 Tadashi
发非阻塞 ask(qid bdab042a)。**Lead 裁定(2026-07-17,comm 91a2f99a / 40a66661):
选项 (b)——FLY-1347 的 pack 文件连同两处更正折进 FLY-1353 本 PR,不等 1347 分支
merge(「三件事一单修完」);「文件来自 1347 分支」不作为 FAIL 理由。** → ③ = PASS。

> 留痕(非阻塞):#635 先合入 main 后,FLY-1347 分支日后若单独开 PR 会与本 PR 的 pack
> 文件撞 add/add 冲突。Lead 已知悉并接受此排序(1347 的调和/关单由 Lead 侧另行处理)。

## 5. 结论

**整体 QA verdict = PASS。** 交付物 ①②③ 全部通过(①② 技术证据充分;③ 内容正确 +
Lead 批准交付方式)。进入 approve gate,等 founder 审批 ship。

**Head 纪律留痕**:QA 报告 commit 使 head 从 implement 的 Codex-approved `cbdfd17e8`
漂到最终 head。QA 阶段在最终 head 重跑 Codex code review(doc-only 增量)使 FLY-827
门绑定当前 head,再开 approve gate。
