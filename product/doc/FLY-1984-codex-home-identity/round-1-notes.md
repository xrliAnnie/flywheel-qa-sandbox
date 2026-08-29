# FLY-1984 进度游标

Issue: FLY-1984 (https://linear.app/geoforge3d/issue/FLY-1984)
日期: 2026-08-25
基于: exploration.md / research.md

## 现在在哪

**A 效果层 · 第 1 轮已交付,等 founder 评审。**

| 步 | 状态 |
|---|---|
| 1 搞懂真意图 | ✅ 已写进 exploration.md,并在 explainer 00 段请她纠正 |
| 2 research + explainer | ✅ 本机实测完成,explainer 已发布 |
| 3 跟 founder co-eval | ⏳ **founder_review 已开,等回复** |
| 4 收敛 PRD | ⬜ 等她这一轮回完才动笔 |
| 5 拆 build issue | ⬜ |

## 本轮产出

- commit `dec5092a4`(已推到 origin/flywheel-FLY-1984,ls-remote 已核)
- 托管页 https://fw-reports-a53de2.vercel.app/r/278056126ea40e3b82e8b23bea1ab38a/
  (verify-report 全绿:http/noncePlaceholder/scriptNonce/expect)
- founder_review questionId `e5524ccb-89c4-4fda-8a81-c9fb491543f1`

## 下一步(拿到她的答案后)

1. 若她说「有定见」→ 对齐,不自由发挥。
2. 若她说「我来发挥」→ 按她答的四题写第一版 PRD,仍然先给她看。
3. 两个未验项(Codex 能不能部分共享记忆 / 打开记忆的成本)如果她要我先验,则本轮插一次调研再回来。

## 会过期的结论

| 结论 | as-of | 重核命令 |
|---|---|---|
| 608 个家 / 44 GB | 2026-08-25 17:00 | `ls -d ~/.codex*` · `ls ~/.flywheel/codex-homes \| wc -l` · `du -sch ~/.codex*` |
| 各家记忆条数(共用 174,其余 0) | 2026-08-25 17:00 | 拷 `memories_1.sqlite` 后 `select count(*) from stage1_outputs` |
| Lead 家没有 memories 开关 | 2026-08-25 | `grep -i "memor\|features" packages/teamlead/scripts/codex-lead-tui-home.sh` |
| 规范账号 3 个 | 2026-08-25 | `cat packages/claude-runner/agents/codex-account-registry.json` |

## 已知噪音(不影响产物)

- `flywheel-comm stage set research` 连续两次返回 aborted(已知 2s 超时假失败),stage 未记录。
- `gate founder_review` 的 lead inbox nudge 报 aborted,但回执写明 durable queue row retained。
