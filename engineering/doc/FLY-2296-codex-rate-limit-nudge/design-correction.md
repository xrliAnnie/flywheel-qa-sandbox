# FLY-2296 Codex TUI 额度换模菜单钉死停驻体 — 设计修正附录

Issue: FLY-2296 (https://linear.app/geoforge3d/issue/FLY-2296/病根-codex-tuiapproaching-rate-limits-switch-to-luna菜单卡住停驻体poller)
日期: 2026-09-03
基于: plan.md(blob 24723fed,Codex 设计评审 R3 APPROVED,manifest rev3 gate 已过)

## 为什么有这份附录

Lead 对 R1 报告的回复(question c7077d3f,20:51Z)带了三条补充要求和一条边界说明。design 节点在 R2/R3 期间没有重新查这条回复,plan.md 定稿并通过 gate 时它们没进去。plan.md 的 blob 已被 APPROVED 判决绑定,不再改写;本附录是对 plan.md 的**增量约束**,实现节点须与 plan.md 一并执行,QA 按本附录的条目验收。

## 修正 1(Lead ①):把「R1 前方案修不到生产 Lead」写成事实

事实陈述,放进 plan §3 的语义里:

> R1 之前的方案把 `ensure_notice_pin` 放在 `codex-lead-tui-home.sh` 的 read-only trust 段之后。生产的 Mufasa 与 infra-bot launcher 都是 `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`,`ensure_home` 在 full-access 分支(第 608–612 行)`write_full_access_config` → `append_full_access_lead_actions_mcp` → `return 0`,根本走不到 trust 段。**若按 R1 前的方案实现,生产 Lead 完全不会被修到,而且每次 full-access ensure 整份重写 config.toml 还会把人手按过的键抹掉。** 这是 Codex R1 的 BLOCKER,不是事后补充的优化。

实现节点在 `ensure_notice_pin` 的调用点注释里引用这一段(一句话即可),让读代码的人知道为什么两条分支都要调。

## 修正 2(Lead ②):fail-close 分支必须给出可执行的人话指引

plan §3 的 `drift` / `present_unpinned` / `error` 三个 `die` 消息改为下面的形状(与脚本里 trust 段的既有 `die` 一样带 `$CONFIG` 绝对路径):

```
drift            → die "Rate-limit model-switch menu is explicitly enabled in $CONFIG — an unattended TUI would wedge on it.
                        Fix: open $CONFIG, find the [notice] table, change
                          hide_rate_limit_model_nudge = false
                        to
                          hide_rate_limit_model_nudge = true
                        then re-run this launcher."
present_unpinned → die "$CONFIG already has a [notice] table without hide_rate_limit_model_nudge; appending a second [notice] table would be invalid TOML.
                        Fix: open $CONFIG, inside the existing [notice] table add the line
                          hide_rate_limit_model_nudge = true
                        then re-run this launcher."
error            → die "Cannot parse $CONFIG (or python3 tomllib is missing) — refusing to guess the [notice] state.
                        Fix: run  python3 -c 'import tomllib,sys; tomllib.load(open(sys.argv[1],\"rb\"))' $CONFIG  to see the parse error, repair the file, then re-run this launcher."
```

runner 侧(`pinRunnerNotice`)的 throw 消息沿用 FLY-1604 的「不回显配置内容」约定,但也要说清动作:`provisionCodexHome: notice is defined as a dotted/inline table in the seed config (~/.codex/config.toml) — rewrite it as a literal [notice] table header before dispatching Codex runners`。

测试:三条 `die` 的用例断言消息里含 `$CONFIG` 的绝对路径与 `hide_rate_limit_model_nudge = true` 这一行。

## 修正 3(Lead ③):探针副本除 notice 段外与原文逐字相同

plan §2.5 的 `codex-tui-nudge-probe.sh` 在复制并剥离 credential 块之后,再加一条断言:

```
把「原 config.toml 去掉 flywheel-managed credential 块」与「副本去掉 [notice] 段和追加的临时 cwd trust 表」逐字 diff,
必须为空;不为空 → exit 2 并打印 diff(说明探针被人顺手改成了会带入别的东西)。
```

也就是副本相对原文只允许三处差异:credential 块(剥掉)、`[notice]` 段(被测变量)、临时 cwd 的 `[projects."<tmp>"]`(探针自身需要)。`--self-check` 里加一组「故意在副本多写一行」的阴性对照,这条断言必须变红。

## 边界补记(Lead):boot 信任菜单不进本单

research §7.1 顺手发现同一探针在 `config/read` 不带 `projects` 时能复现 boot 期「Do you trust the contents of this directory」菜单(FLY-1961 那一类)。**不进本单**;是否立单由 Lead 决定。写进诚实边界,实现节点不为它加任何东西。

## 与 plan.md 的关系

- plan.md 不改(blob 24723fed 是被判决的那个)。
- 本附录与 plan.md 冲突时以本附录为准;冲突只应出现在上面三处消息文案与一条探针断言,不涉及机制。
- 是否需要 Codex 就本附录再跑一轮,由 Lead 裁定;design 节点已按 `phase_design_complete` 收口,附录由当前 TURN 持有者增量落地。
