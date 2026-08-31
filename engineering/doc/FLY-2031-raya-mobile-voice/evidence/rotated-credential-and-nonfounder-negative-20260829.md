# FLY-2031 旋转凭证与非 Founder ship 负测 — QA 证据
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-29
基于: plan.md、founder-round-runbook.md、r2-founder-free-selfcheck-20260829.md

## 结论

旋转后的 credential 已只通过 owner-private 文件交给外部 adapter；Codex Runner 对该文件的直接读取被 host `deny_read` 以 `EPERM` 拒绝。同一 QA voice plist 的产品 `preflight` exit 0，证明 control 可读、credential 对内部 Codex sandbox 不可读之后，Discord 与 Realtime adapter 才启动。随后在实际 `voice-test-2` 房间由非 Founder QA bot 说精确“確認”，ShipGateFlow 正确以 `non_founder_final` 中断，loopback approval `POST=0`，outbox 与 action receipt 都为 0。

本证据只证明非 Founder 零权限与凭证边界，不替代 Founder 真声 P3 阳性。

## 凭证与 preflight

- host 规则：`[permissions.filesystem] deny_read = ["/Users/xiaorongli/.flywheel/raya/qa/FLY-2031/secrets/approval-credential"]`。
- QA plist 不含 legacy `RAYA_APPROVAL_API_TOKEN`；只含 `RAYA_APPROVAL_CREDENTIAL_FILE` canonical path。
- Runner 直接启动 fixture 时，打开 credential 得到 `EPERM: operation not permitted`；没有读取或输出 credential 内容。
- host 以 `com.xrli.raya.approval.fly2031.qa` LaunchAgent 启动 fixture；无认证 `GET /api/voice` 返回 `401`。
- 同一 QA voice plist 临时以 `preflight` 一次性启动，exit `0`，stdout 为 `ready=true`：Discord bot `1542068543645024257` 可见 voice channel `1542708795720081408`；Codex thread `01a04d5a-4664-7142-9a8b-7db230a21343`，model `gpt-5.6-sol`，Realtime `started`。
- `runVoiceCli(preflight)` 只有在 `assertApprovalCredentialIsolation` 的 control probe exit `0` 且 credential probe 为 permission-denied 后才会调用 Discord/Realtime preflight，因此该 `ready=true` 是两半 gate 的产品级通过证据。
- Runner 已在 Seatbelt 内，另行嵌套 `codex sandbox` 的两条复跑均因 `sandbox_apply` exit `71` 而无法初始化；这组结果明确排除，不计通过或失败证据。

## 实际 Discord 非 Founder negative

- 运行 head：`5c9cfd0`；全仓 `pnpm lint`、`pnpm -r build`、`pnpm typecheck`、`pnpm test` 全绿（58 contracts、270 voice、125 brain、70 QA）。
- 独立 state：`qa/FLY-2031/rounds/independent/state`；生产 state / plist / label 未触碰。
- fixture 基线：40 行、历史 authorized GET 1、POST 0。
- QA bot `1516207680836866219` self-muted 入房 15 秒；ShipGateFlow 现查 binding/context 后念出 `FLY-2031 · PR #2031` 并 `ship_gate_armed`。
- QA bot 播放精确确认音频；权威 transcript：`text="確認"`、`speakerUserId="1516207680836866219"`。
- 下一事件：`ship_gate_context_interrupted{reason:"non_founder_final"}`。pending item 随后安全 re-arm，因此本轮 fixture delta 是两组 authorized `GET gate-binding + GET context`，合计 4 GET；没有 POST。
- 监听器收到 Raya `293` Opus packets、`36,207` bytes；voice job 在 listener 离房后 `voice_exit{code:0,reason:"last-human-left"}`，launchd 最终 `not running`、last exit `0`。
- 场后：approval POST `0`；outbox files `0`；action receipt lines `0`。

## 脱敏文件指纹

| 文件 | 行数 | SHA-256 |
|---|---:|---|
| preflight stdout | 11 | `aceda6502edea6551521e51b7a0680a3a370d08ab4cca7f16c762eacc9e4a49e` |
| approval request log | 44 | `e31e138f772f9ad8ac8919cbcd39dbf2d70160e7e15c7cc35e7e41c8aae0928d` |
| independent voice evidence | 114 | `2b36beb694f7239e7392eff7a3880b7cfb65631139d4a350ee2081f20b473604` |
| non-Founder emitter evidence | 7 | `a5813765e32f88c9e47e85e9e16937030ef6afad1eb2dae15c84d44415701449` |

credential 内容、bot token 与原始音频均未入仓。
