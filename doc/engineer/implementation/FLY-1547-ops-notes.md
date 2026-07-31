# FLY-1547 运维接线说明(operator 侧,merge 后按此启用)

**Issue**: FLY-1547
**Date**: 2026-07-30
**性质**: 所有开关都是"配置存在即启用"——不加任何 flag;不配置 = 字节不变。

## 1. `~/.flywheel/v2/bin/register-operator-lead.sh`(运维文件,repo 外)

给 `register-lead` 加 credential 落盘(lead 走 mailbox MCP 面的前提):

```diff
 exec "$NODE" "$CLI" register-lead \
   --socket "$V2/host.sock" --secret "$V2/host.secret" \
   --agent flywheel-eng-lead --instance v2-flywheel-eng-lead-1 \
   --host-epoch fly1502-prod-h1 \
   --session-id "cmux-flywheel-flywheel-eng-lead" \
   --session-proof-root "$V2/session-proofs" \
-  --pid "$CLAUDE_PID" --pid-start "$PID_START"
+  --pid "$CLAUDE_PID" --pid-start "$PID_START" \
+  --delivery-credential-out "$V2/state/flywheel-eng-lead-credential.json"
```

**takeover 生命周期(R4-F4 冻结,按序执行,不许并行两个活 MCP child)**:

1. **先停旧 child**:关闭旧 lead 会话(或至少 kill 其 flywheel-v2-mailbox 子进程)——旧 child 在启动时缓存了自己那代的 credential(包内 R3-F4 修复),绝不会收养新凭据,但两个活 child 并发拉同一信箱会互相触发 §2.1 lost-handoff 重投,故先停旧;
2. **精确选中新 lead 进程**:脚本的 `ps | head -1` 在新旧并存时可能选错——重跑注册前必须确认唯一存活的 lead claude 进程(建议把 grep 收紧到会话名/启动时间,或手动传 PID);
3. 重跑本脚本:`register-lead` 记新代 + `--delivery-credential-out` **原子**落盘(CLI 已改 temp+fsync+rename+dir-fsync);host 同步撤销旧代 bearer;
4. 新 lead 会话启动 → 新 MCP child 启动时读新文件。
若旧 child 未被停(违反第 1 步):它持旧 bearer,下一次调用被 host fence 拒 → 铃失败计数 → fail-stop 删 lease,行为可见——但请勿依赖该兜底,先停旧是纪律。

## 2. `~/.flywheel/v2/runtime-config.json`

launcher 段加一个键(runner 侧 mailbox 服务 + codex 远控形态的唯一开关):

```diff
   "launcher": {
     ...
-    "claude_credentials": "/Users/xiaorongli/.flywheel/v2/claude-credentials.json"
+    "claude_credentials": "/Users/xiaorongli/.flywheel/v2/claude-credentials.json",
+    "mailbox_mcp": "/Users/xiaorongli/Dev/flywheel/packages/v2-mailbox-mcp/dist/server-main.js"
   },
```

host 重启后生效。启用后:claude runner spawn 带 mailbox MCP + channel 铃;codex runner spawn 切远控附着形态(daemon + `resume --remote`);doorbell 三通道路由生效。**不配置该键 = 全部旧行为**。

## 3. lead 会话(claude-lead.sh 已在本 PR 接线)

lead 侧 mailbox MCP 的启用条件 = ①`packages/v2-mailbox-mcp` 已 build ②`$V2/state/<LEAD_ID>-credential.json` 存在(即步骤 1 已做)。两者齐 → 下次 lead 重启自动注册 `flywheel-v2-mailbox` server + dev channel;否则日志 `v2 mailbox MCP: skipped`,行为不变。

## 4. 验证顺序(建议)

1. 步骤 1(credential 落盘)→ `mailbox-status --agent flywheel-eng-lead --delivery-credential-file ...` 应返回账面;
2. 步骤 2 → 起一个测试 issue,确认 claude runner pane 出现 mailbox 工具、codex runner pane 是 `resume --remote` 形态、doorbell events 里 `session_bell_rung.channel` 符合路由;
3. 步骤 3 → lead 重启后 `.mcp.json` 含 `flywheel-v2-mailbox`,铃通知可达。

## 5. founder_push(已默认 off)

`runtime-config.json` 顶层可选 `"founder_push": true` 才会把 progress ask 推 Discord;缺省 off,ask/blocked 永远只进 lead 信箱。开关由 founder 真机验收后决定。
