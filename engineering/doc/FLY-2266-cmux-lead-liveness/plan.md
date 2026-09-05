# FLY-2266 Lead 面板重连可见性 — 实施计划
Issue: FLY-2266 (https://linear.app/geoforge3d/issue/FLY-2266/cmux-先于全舰重启时v2-lead-面板会全体孤儿且无自愈-昨夜-1115-冻结-12h45m-无人发现潜伏缺口非每日发作)
日期: 2026-09-04
基于: research.md

## 1. 交付结果

当 v2 Claude Lead 的 cmux direct-attach surface 在全舰重启后没有重新连上新的私有 tmux server 时：

- watcher 用私有 socket 的 `main` client 数判断真实连接，不被历史画面里的 Lead 名称欺骗；
- 每轮留下 `lead-attach census expected=N attached=M missing=<titles|none>` 对账日志；
- 三次既有安全重连预算耗尽，或同一 Lead 连续三轮 census 仍缺席时，通过现有 `cmux_cleanup` episode 通道主动告警；
- 连接恢复或 Lead 从 loaded roster 消失后自动 re-arm，同一 Lead 再次失联会产生新 episode。

## 2. 锁定范围

只改：

- `scripts/flywheel-cmux-sync.sh`
- `scripts/__tests__/fly2266-cmux-lead-attach-health.test.sh`（新增）
- `.github/workflows/ci.yml`（把新增 hermetic suite 字面枚举进 CI）
- 本 issue 文档与最终 milestone

不改 cmux 本体、Lead launcher、restart-services、Bridge API、alert kind union、任何依赖或配置开关。告警事件 kind 继续是既有 `cmux_cleanup`；只新增 episode kind `lead-attach-missing`，subject 为 Lead title。

## 3. TDD 实施顺序

### 3.1 RED：重启顺序回归

先新增 hermetic shell test，模拟两名 `claude-private` Lead：

1. cmux restart 后两者 client count 均为 1，要求 census `2/2/none`；
2. fleet restart 后 client count 均为 0，surface 保留旧 Lead 名但为可安全注入的 bare shell；
3. A 恢复 client=1，B 保持 client=0；B 缺席前两轮只记录 census，第三轮产生 `lead-attach-missing|demo-b-lead|e1`；当前代码应因没有告警/census 而红；
4. B 从 loaded roster 消失一轮，断言其 `lead-attach-missing` episode 与连续缺席计数都被 re-arm；
5. B 回到 roster 后仍保持 client=0，连续三轮后产生 `e2`；
6. B 恢复 client=1 后再次失联，连续三轮后产生 `e3`。

测试替换外部 tmux/cmux/alert 边界，不读写生产 socket、state 或 workspace；必须把 `ROSTER_EPISODE_STATE` 与 `ATTACH_HEAL_STATE` export 到 sandbox。额外断言 client 查询失败不会计入 attached，旧画面里的 Lead 名称不会改变判定。

### 3.2 GREEN：统一健康判定与 episode

在 `recover_attach_surface()` 的 `bare` 预算耗尽分支，状态与红色 pill 成功持久化后：

```text
if kind == v2; then
  roster_alert_unhealthy lead-attach-missing title ...
fi
```

必须使用 `if …; then …; fi`，不能用会在 `set -e` 下让 `kind=view` 返回非零的尾随 AND-list。不改变普通 Runner `kind=view` 行为，不改变 retry 次数、send guard 或 return code。

在 `reconcile_v2_lead_workspaces()` 的只读 census 中统一维护 `lead-attach-missing` episode：

- client count 为严格正整数：清零该 title 的连续缺席计数，并 `roster_mark_healthy lead-attach-missing title`；
- 其余结果：递增该 title 的进程内连续缺席计数；固定 K=3，第三轮起调用同一个 `roster_alert_unhealthy`，后续轮次由 episode 去重；
- 本轮 roster 不含的旧 title：清零其连续缺席计数，并按既有模式调用 `roster_rearm_absent_subjects lead-attach-missing`，明确把该 Lead 的 episode 重置为 healthy。

连续缺席计数只用 Bash 3.2 兼容的进程内换行字符串，不新增状态文件、配置开关、kind 或告警通道。私有 client 查询必须写成 `count=$(_private_session_client_count "$socket") || count=""`；失败值归 missing，不能让 `set -e` 杀掉 watcher pass。

### 3.3 GREEN：整轮 census

在 `reconcile_v2_lead_workspaces()` 的 mutation loop **之前**独立跑完整只读 census，使 `watcher_mutation_latch_clear` 失败也不会跳过对账。census 维护：

- `expected`：`claude-private` 行数；
- `attached`：`_private_session_client_count(socket)` 返回严格正整数的行数；
- `missing`：其余 title，稳定使用逗号连接；空集写 `none`。

循环后输出固定前缀的 INFO：`lead-attach census expected=N attached=M missing=...`。census 只读，不授权任何 cmux mutation 或 cleanup；读取失败列 missing，不伪装为 attached。

随后保留现有 mutation loop；把 latch 分支从整函数 `return 0` 收敛为停止 mutation 的 `break`。这样 `ensure_v2_lead_workspace` 的 surface 查找失败、deferred 返回与 unreceipted same-title early return 都已先被 census 计入，并在连续 K=3 轮后通过 §3.2 的同一 episode 通道发声。

### 3.4 REFACTOR

只消除测试里不必要的重复；不抽象新 helper，除非一条现有 stdlib/shell 表达式无法清晰完成。检查 diff，删除任何为未来 carrier/指标系统预留的代码。

## 4. 验证矩阵

按 Lead 的单包/单线程约束，不跑 `pnpm -r` 或 packages-wide 测试，也不运行 `packages/core/test/tmux-viewer.macos.test.ts`。

本节点执行：

```bash
bash -n scripts/flywheel-cmux-sync.sh scripts/__tests__/fly2266-cmux-lead-attach-health.test.sh
bash scripts/__tests__/fly2266-cmux-lead-attach-health.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/fly1663-cmux-v2.test.sh
bash scripts/__tests__/fly1884-attach-recovery.test.sh
bash scripts/__tests__/fly1446-cmux-roster.test.sh
```

运行 FLY-1884 前后用一行 shell check 比较 `$HOME/.flywheel/state/cmux-roster-episodes` 的 `stat -f '%m'`（文件不存在时统一记 `absent`），断言 mtime 不变；这证明旧套件不会因新 v2 告警路径触碰生产 episode 账本。

如相关小套件暴露同一行为，再补跑 `bash scripts/test-cmux-sync.sh`；不以窄测试冒充生产重启验收。

独立 QA 的真实回归：在受控环境先重启 cmux，再重启 Lead fleet，故意让一名 v2 Lead surface 无法重连，核 census、告警与恢复 episode。实现节点不重启生产 Bridge/Lead/cmux。

## 5. 提交、PR 与评审

1. 提交并钉住本计划，通过 design review 后才写测试代码。
2. RED 测试与最小 GREEN 分成小提交；更新 progress ledger。
3. 推送并尽早创建目标为 `main` 的 PR，正文含 Linear 链接与 Test plan。
4. 运行相关验证，将 `engineering/doc/milestones/FLY-2266.md` 作为 literal last commit。
5. 通过 `codex:rescue` 发起 code review，再注册 `review_code` gate；评审期间不 push。
6. CHANGES_REQUESTED 时批量修复、一次 push、重新开新 gate；APPROVED 后不再运行 progress 或推 docs-only commit，只更新 PR body。
7. 完成时向 Lead 回报并执行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 merge、不 deploy。

## 6. 可证伪验收

| 要求 | 证据 |
|---|---|
| 不靠画面判健康 | 测试给 B 保留旧 Lead 字样，但 client=0；attached 不得增加 |
| 能回答 N/M/缺谁 | grep 固定 tag `lead-attach census expected=2 attached=1 missing=demo-b-lead` |
| M≠N 主动发声 | 同一 title 连续三轮 missing 后 alert signature 含 exact title 与 `e1` |
| 不重复轰炸 | 同一 unhealthy episode 多轮只有一次 alert |
| 能自愈且可复发 | client 恢复或 roster 缺席均 re-arm；后续失联得到新 episode |
| 不误伤其它路径 | FLY-1663、FLY-1884、FLY-1446 相关 shell suites 全绿 |

## 7. 风险与失败方向

- 正常重启瞬时 0 client：前两轮只记 census；固定三轮缺席门槛与既有三次 retry budget 共同避免首轮瞬时抖动告警。
- tmux client 查询失败：census 记 missing，恢复逻辑不做额外 mutation；不能报成 attached。
- surface ref 缺失、`ensure_v2_lead_workspace` deferred、unreceipted same-title early return：三条路径都由 mutation 之前的 census 计入，连续三轮后主动告警，不再只留 watcher 日志。
- episode state 无法写：现有 helper 会 WARN，但不会伪造“已告警”；后续轮次继续尝试。
- client count 证明的是该规范私有 server 当前有显示客户端；一 Lead 一 server/一 main session 是 FLY-1663 已锁定的 v2 carrier 合同。本单不外推到 codex-tui/shared carrier。
