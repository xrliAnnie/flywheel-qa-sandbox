# FLY-756 cmux-sync nested-attach — 实施计划

Issue: FLY-756 (https://linear.app/geoforge3d/issue/FLY-756/infra-cmux-sync-healreopen-注入竞态-runner-pane-里出现-nested-attach)
日期: 2026-07-02
基于: exploration.md, research.md

## 目标

治 `sessions should be nested with care` dead pane：从源头掐断"跑 attach 的 shell 带
`$TMUX`"，并原子化 heal/reopen 的 gate→send 竞态。既有 292 (bash) + FLY-560 vitest 测试不回退。

## 改动清单（3 处代码 + 对应测试）

### Change 1 — 环境卫生：两个 cmux-sync attach 命令前置 `env -u TMUX`

`scripts/flywheel-cmux-sync.sh`

**1a. heal 注入命令**（`heal_send_attach`）
```diff
-  printf -v attach_cmd "tmux attach -t '=%s'\n" "$view_session"
+  printf -v attach_cmd "env -u TMUX tmux attach -t '=%s'\n" "$view_session"
```

**1b. workspace 启动命令**（`create_workspace_for_window`，:1864）
```diff
-  if ! cmux_call new-workspace --command "tmux attach -t '=${view_session}'"; then
+  if ! cmux_call new-workspace --command "env -u TMUX tmux attach -t '=${view_session}'"; then
```

理由：`tmux` 用 `$TMUX` 判 nesting。`env -u TMUX tmux attach …` 让子进程永远看不到继承的
`$TMUX`，单条命令、原子、不残留改 shell env。只 unset `TMUX`（nesting 判据），不碰
`TMUX_PANE`（信息性，非判据）——最小改动。

### Change 2 — gate→send 原子化：普通 heal 路径也走 final-guard

`scripts/flywheel-cmux-sync.sh` `heal_send_attach`：删掉 `HEAL_RENDER_ESCALATE` 分叉，
**两条路径统一成单一 guarded send**（复用 FLY-254 已有、已 Codex-reviewed 的
`cmux_call_guarded _heal_send_final_guard`）。

调用序列（`self_heal_one_workspace` → per-ref `self_heal_workspace_ref`）：outer read
(:1652) → 每 ref GATE1 (:1182) → **[新增]** per-ref final-guard read（`_heal_send_final_guard`
里的 `view_session_client_count`）→ send。即普通路径每 ref **多一次** `tmux list-clients`
（send 前最后一刻 re-check）。

```diff
-  if [[ "${HEAL_RENDER_ESCALATE:-0}" == "1" ]]; then
-    _GUARD_VIEW_SESSION="$view_session"
-    cmux_call_guarded _heal_send_final_guard send --workspace "$ref" --surface "$surface_ref" "$attach_cmd" || true
-    if [[ "$GUARD_WAS_BLOCKED" == "1" ]]; then
-      return "${GUARD_BLOCK_RC:-1}"
-    fi
-    return 0
-  fi
-  cmux_call send --workspace "$ref" --surface "$surface_ref" "$attach_cmd" || true
-  return 0
+  # FLY-756: final 0-client guard runs for BOTH plain and escalated heal now.
+  # self_heal_workspace_ref's 0-client GATE → this send has a bookkeeping
+  # window; a focus-triggered attach in it injected `tmux attach` into a live
+  # pane (nested-attach). _heal_send_final_guard re-checks 0-client as the
+  # genuine last op before the cmux send (cmux_call_guarded prepares its temp
+  # file first, so no bookkeeping sits between check and send). Generation pin
+  # inside the guard is a no-op in plain mode (HEAL_SWEEP_GEN_IDENT unset).
+  # Single injection path — FLY-254 R1 HIGH-1 invariant preserved & strengthened.
+  _GUARD_VIEW_SESSION="$view_session"
+  cmux_call_guarded _heal_send_final_guard send --workspace "$ref" --surface "$surface_ref" "$attach_cmd" || true
+  if [[ "$GUARD_WAS_BLOCKED" == "1" ]]; then
+    return "${GUARD_BLOCK_RC:-1}"
+  fi
+  return 0
```

不变式：升级模式 byte-identical；普通模式新增 send-前 0-client re-check（rc 2=client 出现
→ caller `self_heal_workspace_ref` 返 2 "healed/attached"，既有 caller 已处理 0/1/2）。

**同时更新会变 stale 的注释**（Codex R1 #3）：`heal_send_attach` 上方 :1141-1150（原写普通
模式 "no guard, no extra calls"）与 :1197-1199（原写普通模式 "always returns 0"）—— 改为
"普通/升级路径同走 guarded send；generation pin 仅在 `HEAL_SWEEP_GEN_IDENT` 已设时生效；
普通路径现在可返 1(fail-closed)/2(client-appeared)"。

### Change 3 — FLY-560 rescue 命令加 `env -u TMUX`（Lead 批准）

`packages/teamlead/src/bridge/tmux-lookup.ts` `buildAttachCommand`：
```diff
   if (target.kind === "cmux") {
-    cmd = `tmux attach -t '=${target.session}'`;
+    cmd = `env -u TMUX tmux attach -t '=${target.session}'`;
   } else {
-    cmd = `tmux attach -t '=${target.session}' \\; select-window -t '=${target.tmuxWindow}'`;
+    cmd = `env -u TMUX tmux attach -t '=${target.session}' \\; select-window -t '=${target.tmuxWindow}'`;
   }
```
ssh 分支不变（外层 `ssh host -t '<escaped>'` 自动把新前缀包进去；转义逻辑不变）。

## 测试（TDD：先改断言 RED → 实现 GREEN）

### bash 测试 `scripts/test-cmux-sync.sh`（macOS /bin/bash 3.2）

- **改 全部 4 处**现有 `tmux attach` send 断言，均加 `env -u TMUX`（Codex R1 #2 — 原计划漏数）：
  - `:1914`（FLY-169 Test 1，`workspace:1 --surface surface:1`）
  - `:1966`（`--surface surface:7 tmux attach`）
  - `:2072`（`workspace:5 --surface surface:5`，verify-at-create ref-scoped）
  - `:2513`（`workspace:7 --surface surface:7`）
- **改** 序列敏感 mid-loop TOCTOU 夹具（`:2030`，Codex R1 #2）：普通路径新增 per-ref
  final-guard read → ref1 的 GATE1 与 send 之间多一次读，索引右移。
  `MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,2"` → **`0,0,0,2`**（outer=0 / ref1 GATE1=0 /
  ref1 FINAL-GUARD=0 送 / ref2 GATE1=2 break），同步改注释。
- **新增** create attach 断言：`new-workspace --command` 含 `env -u TMUX tmux attach`
  （当前 :665 只 `grep -c "^new-workspace"` 计数，不验命令体）。
- **新增** FLY-756 普通路径 gate→send 竞态 case（Codex R1 #2 建议法）：直接
  `self_heal_workspace_ref "lead-a" "workspace:1"`，`MOCK_TMUX_CLIENTS="cmux-lead-a=0,1"`
  （GATE1=0 过 → final-guard=1 client 出现）→ 断言**不 send**、rc=2。正向 case 已由既有
  `:2069` Test 11（static `=0`）覆盖：final-guard 仍 0 → 正常 send（该断言此次会加 env -u TMUX）。

### vitest（FLY-560）

验证命令（包名是 `flywheel-teamlead`，**不是** `@flywheel/teamlead`——后者 `pnpm --filter`
无匹配却 exit 0 = 假绿陷阱，Codex R1 #1。注：`exec vitest` 在本仓 bin 未 link，用 `run test`
走 package 的 `test` script；fresh checkout 需先 `pnpm install` + `pnpm -r build`，否则
`flywheel-comm/db` 等 dist 缺失导致 import 解析失败）：
```bash
pnpm -r build   # 先 build 依赖（flywheel-comm/db 等 subpath export → dist）
pnpm --filter flywheel-teamlead run test \
  src/__tests__/tmux-lookup.attach.test.ts \
  src/__tests__/tmux-lookup.real-tmux.test.ts \
  src/__tests__/event-route.attach-pin.test.ts \
  src/__tests__/ChatThreadCreator.attach-pin.test.ts
```
- **改** `tmux-lookup.attach.test.ts`（cmux :99 / base-fallback :109 / ssh :119 三断言）→ 加 `env -u TMUX`。
- **改** `tmux-lookup.real-tmux.test.ts:192`、`event-route.attach-pin.test.ts:167`、
  `ChatThreadCreator.attach-pin.test.ts:25` 的期望字符串 → 加 `env -u TMUX`。
- `StateStore.test.ts` 的 `command:` 是任意存取字符串、非 buildAttachCommand 输出 → **不动**。

## 回归 / 验证

1. `/bin/bash scripts/test-cmux-sync.sh` → 292+新增全绿（后台跑，前台 pipe 会因测试内 sleep 挂）。
2. `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` → 绿。
3. `pnpm -r build` 后 `pnpm --filter flywheel-teamlead run test src/__tests__/tmux-lookup.attach.test.ts src/__tests__/tmux-lookup.real-tmux.test.ts src/__tests__/event-route.attach-pin.test.ts src/__tests__/ChatThreadCreator.attach-pin.test.ts`（包名 `flywheel-teamlead`，非 `@flywheel/teamlead`）→ 绿。
4. 全仓 `pnpm lint`（biome）。
5. `bash -n scripts/flywheel-cmux-sync.sh` 语法。

## 风险 / 边界

- **不动** FLY-293 reaper（它正确，本 issue 只治它放大暴露的底层注入卫生）。
- **不动** Terminal.app 路径（fresh shell，类 1，不会 nested）。
- **不新增** 周期扫描 / timer（Annie 否决 polling）——纯改既有事件驱动路径。
- `env -u TMUX` 依赖 `env`（coreutils，PATH 必有）；cmux surface / bare shell 均可用。
- 普通 heal 路径新增一次 `tmux list-clients`（事件驱动，非周期）——可忽略负载。

## 验证结果（2026-07-02 实测）

- `bash -n scripts/flywheel-cmux-sync.sh` → **OK**。
- `/bin/bash scripts/test-cmux-sync.sh` → **295 passed, 0 failed**（基线 292 + 3 净新断言：
  create `env -u TMUX` + FLY-756 竞态 2 条）。RED（改前）确认 4 处 attach + 竞态断言失败。
- `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` → **11 passed, 0 failed**。
- `pnpm --filter flywheel-teamlead run test`（4 个 attach 文件）→ **32 passed**（含 real-tmux
  用 `bash -n` 验 `env -u TMUX` 命令 shell 合法）。
- `pnpm lint`（biome，全仓 1077 文件）→ **exit 0**，我改的文件零 warning。
- 全 teamlead 回归 `pnpm --filter flywheel-teamlead run test` → 4054 passed / 9 failed；**9 个
  失败全为 pre-existing 环境 flake**（close-runner/createLeadRuntime 5000ms 超时、fly247 `spawn
  git ENOENT`、publish-html Vercel 500），与本改动无代码路径关联；4 个 attach 文件全 ✓。
