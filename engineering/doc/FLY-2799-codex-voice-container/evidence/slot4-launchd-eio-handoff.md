# FLY-2799 slot 4 launchd EIO — 交接
Issue: FLY-2799
日期: 2026-09-24
基于: plan.md

## 结论

当前实现头 `254ebfe76906aec34e72eff8bc9cab6c3e6c5cfe` 已生成正确的 Codex QA 载体，且在真实 `launchctl bootstrap` 前通过精确守卫：`ProgramArguments` 是 `/bin/bash` 加 slot-local `codex-lead-wrapper.sh`。随后 macOS `launchctl bootstrap` 仍返回 `Bootstrap failed: 5: Input/output error`，label 未注册、19874 无监听。

因此这一次 EIO 已排除“误走 Claude `flywheel-lead-wrapper-v2.sh`”这个原因。房间 daemon 尚未启动，不能声称完成 60 秒烟雾或转写。

## 完整 deploy 命令与参数

工作目录：`/Users/xiaorongli/Dev/flywheel-FLY-2799`

```bash
FLYWHEEL_QA_LAUNCHCTL="$PWD/.flywheel/runs/fly2799-launchctl-guard.sh" \
  scripts/test-deploy.sh 4 \
  --generalized \
  --mode slot \
  --expect-head 254ebfe76906aec34e72eff8bc9cab6c3e6c5cfe \
  --voice-fixture /Users/xiaorongli/.flywheel/artifacts/FLY-2799-qa/voice-fixture-slot2.json
```

临时 slot registry 只给 slot 4 增加：

```json
{
  "backend": "codex-app-server",
  "codexProfile": "full-access"
}
```

registry SHA256：

- 修改前：`3ee5f044f3ef14f3728e5532b512d99805a4f2783fb5e5522598a4c41bdc415f`
- 临时 Codex 配置：`4942ea6f7d693ca974fa9c4e955fd9480cfd3bb57b84a4e8370a4b0d69ded732`
- 停止后恢复：`3ee5f044f3ef14f3728e5532b512d99805a4f2783fb5e5522598a4c41bdc415f`

## bootstrap 前守卫

守卫在调用 `/bin/launchctl` 前读取 plist，并只接受下列精确数组；本次日志先打印：

```text
[fly2799-launchctl-guard] verified /bin/bash + codex-lead-wrapper.sh before bootstrap
```

随后才出现：

```text
Bootstrap failed: 5: Input/output error
Try re-running the command as root for richer errors.
[qa-launchd] ERROR: bootstrap failed: com.flywheel.qa.lead.slot-4.flywheel-test-4
```

## 生成的 lead.plist 全文

路径：`/tmp/flywheel-test-slot-4/launchd/flywheel-test-4/lead.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>FLYWHEEL_CODEX_TMUX_BIN</key>
		<string>/opt/homebrew/bin/tmux</string>
		<key>FLYWHEEL_CODEX_TMUX_VERSION</key>
		<string>tmux 3.7c</string>
		<key>FLYWHEEL_DIR</key>
		<string>/Users/xiaorongli/Dev/flywheel-FLY-2799</string>
		<key>FLYWHEEL_STATE_DIR</key>
		<string>/tmp/flywheel-test-slot-4/q/4</string>
		<key>HOME</key>
		<string>/Users/xiaorongli</string>
		<key>PATH</key>
		<string>/Users/xiaorongli/.local/bin:/Users/xiaorongli/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>TMUX_TMPDIR</key>
		<string>/tmp/flywheel-test-slot-4</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.flywheel.qa.lead.slot-4.flywheel-test-4</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>/tmp/flywheel-test-slot-4/launchd/flywheel-test-4/codex-lead-wrapper.sh</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>/tmp/flywheel-test-slot-4/lead.log</string>
	<key>StandardOutPath</key>
	<string>/tmp/flywheel-test-slot-4/lead.log</string>
	<key>ThrottleInterval</key>
	<integer>3</integer>
</dict>
</plist>
```

## 停止点与保留现场

- label `com.flywheel.qa.lead.slot-4.flywheel-test-4` 不存在。
- TCP 19874 无监听。
- `/tmp/flywheel-test-slot-4.lock` 由失败清理保留，内容为 `claiming`。
- slot-local Codex home/credential residue 由失败清理保留；实现体未删除。
- 未碰 `cmux-maintenance`，未动 slot 2/3，未手动 `bootout` 或 `teardown`。
- 临时全局 slot 4 registry 已恢复；一次性本地守卫已删除。

