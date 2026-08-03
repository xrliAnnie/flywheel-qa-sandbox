# FLY-1602 两案相撞与合并决定 — design-correction

Issue: FLY-1602 (https://linear.app/geoforge3d/issue/FLY-1602/基建a-重启换代-lead-失败即孤儿-lease-catch-22-每次-restart-挂掉只能人工捞回)
日期: 2026-08-02
基于: plan.md(合并稿 v8)

## 发生了什么

本 issue 在同一天被两次独立派发,产出两份互不知情的设计:

| | 今晨案(第一次派发) | 今晚案(第二次派发) |
|---|---|---|
| 产出 | exploration/research/plan(W1-W4)+ founder HTML(已交付) | exploration/research/plan(方向 B) |
| 孤儿处置 | **收养**(证据闭集 + adopt CAS,V1-V9 不变量) | **清除重生**(reap-and-respawn + 二维判定) |
| review | Codex design review **7 轮 APPROVED**(commit 44b6d235,push 到 origin) | Lead 口头批准方向,Codex review 未启动 |
| 独有诊断 | storm gate 在验证窗口内静默否决 wrapper;kickstart -k 旁路连环杀 supervisor(W3/W4) | 4/5 换代失败是假阴性(62s 窗口 vs 2-15min 真实换代,lease history 铁证);02:08 restart 进程 mid-crash 留 unloaded 中间态 |

## 为什么会撞

**成因(Lead 自认)**:今晨案完成设计节点交付后,重新派发本 issue 时 Lead 未指示 continuation runner「先读分支上已提交的设计」(continuation 标准纪律遗漏)。第二位 runner 按仓规检查了 `engineering/doc/` 下的 FLY-1602 前缀文件夹——但其 worktree 从 main 分叉,今晨案只存在于 origin/flywheel-FLY-1602,worktree 里不可见;直至 Codex review 启动时在 /tmp 撞见今晨的 7 轮 feedback 文件才发现。

第二位 runner 发现后停手上报、给出对比与合并建议,未自行择一。

## Lead 裁定(2026-08-02 晚)

**以今晨案(R7-approved,W1-W4)为基座**,折入今晚案独有的两块(W5 验证三态+终判、W6 病 C marker)与假阴性证据组(research.md §5)。五条要求:

1. rebase 到 44b6d235,W1-W4 全保留;W5/W6/证据组按今晚案方案折入 ✓
2. R8 增量 review 首要审题:收养链是否对活 body 保持零权威路径(FLY-1507 铁律);判违律则整案回退清除重生
3. 今晚批方向 B 时的四条要求随行进合并稿(证据进 research ✓ / converging 终判 = W5 ✓ / 病 C = W6 ✓ / 变异判据 = W5 测试 ✓)
4. 本文件:诚实记录相撞与成因 ✓
5. 方向澄清:当晚对「方向 A」的否决只针对**朴素收养**,不针对证据闭集版(已注入 plan.md 头部)✓

## 今晚案的完整原稿去向

git 历史 commit `8c7235b1`(`engineering/doc/FLY-1602-restart-orphan-lease-catch22/`,三文档全文);合并后该文件夹从 tree 移除,独有内容已折入本文件夹的 research.md §5 与 plan.md W5/W6。若 R8 判收养违律,回退方案(清除重生)的机制细节以该 commit 的 plan.md §2.4 为准。

## 流程教训(供 retro 采收)

1. **重派 = continuation**:issue 重派时 Lead 必须指读「分支上已提交的设计」,runner 必须 `git fetch && git log origin/<branch>` 核对远端,而不只 ls 本地 worktree 文件夹。
2. 设计节点的 /tmp review 轮次文件是跨会话的碰撞信号源(本次靠它发现相撞)——但不该是唯一防线。
