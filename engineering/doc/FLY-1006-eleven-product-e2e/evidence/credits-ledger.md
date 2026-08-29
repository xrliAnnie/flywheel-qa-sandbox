# FLY-1006 credits 台账（P8，滚动更新）

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-08（起）
基于: plan.md §1（~177 credits/min 基准 = FLY-980 v10 实测口径）

Creator $22/月，character_limit 159,648。raw 快照留档
`~/fly1006-eleven/usage-*.json`（同步自 spike out/）。

| 快照点 | character_count | 增量 | 归因 |
|--------|-----------------|------|------|
| fly1006-before-all（开跑前） | 7,451 | — | 历史用量（含 980 全程 7,264 + 零头） |
| fly1006-after-operator | 8,100 | **+649** | M1 操作者自测：冒烟 2 轮 + 3 Lead override 会话各 1 轮 + 3 次 1008 失败连接（秒关，基本零耗） |
| fly1006-after-annie-s1 | 8,705 | **+605** | Annie session 1（Tadashi，链路通但脑撞 session limit，垫话/STT 照常计费）+ 操作者 brain-verify 1 轮 |
| fly1006-after-lang-fix | 11,860 | **+3,155** | Annie session 2（重测，M1 终验 ✓，多轮真聊）+ 反馈③垫话语言修复的 3 个诊断会话（共 6 轮） |
| fly1006-after-annie-s3 | 12,618 | **+758** | 无垫话验证 1 轮 + Annie 声效版体验（session 3-5：Tadashi/Cass/Belle 短会话）+ Jason 中文原生声线试听会话 |
| s8-pre（2026-07-09 开跑前） | 12,786 | +168 | M1 尾声零散试听/诊断零头 |
| s8-post | 13,958 | **+1,172** | M2 staged venue 全程：leg 0 冒烟 + mutex×2（自身零 Eleven 会话）+ 音频腿失败 1 跑（shim 崩，STT 照常计费）+ 音频腿 PASS 1 跑（4 轮真 TTS） |
| s8-post-codex-fix（07-09 15:29） | 14,458 | **+500** | Codex R1 修复后 staged 三腿复跑（m2-staged-venue.md 散文有记，QA 指出漏进表——补账） |
| qa-rerun（07-09 QA 独立复跑） | 15,456 | **+998** | QA kickback 独立复跑：leg 0 + mutex + audio 三腿 + fail-closed 负向对照 |
| qa-cue-复验 + Annie P6（合并区间，07-09 傍晚） | 20,429 | **+4,973** | QA 对 waiting-cue 修复的真机复验（cue 腿）+ Annie P6 真人语音房会话（多轮）。两者共享区间无法逐项拆分，如实合并记账 |
| sonnet-retest-post（07-09 20:43） | 22,168 | **+1,739** | 脑换档 sonnet 后 staged audio 腿复测：2 次失败跑（p6 venue 抢 voice session，非 sonnet 原因）+ 1 次 PASS 跑（4 轮真 TTS） |

- 预算对照：plan §2 P8 预期全程 <15,000 credits；当前累计 22,168 − 7,451 = **14,717**（**98.1%，预期额度基本用满**）。注：15,000 是 plan 的预期性估算，非硬墙——钱包硬上限是 Creator 月度 character_limit 159,648，无操作风险；但后续每次真机会话（含 Annie 的下一次试听）都会超出 P8 预期值，记账继续滚动。
- 后续快照点：Annie sonnet 版试听前后。
