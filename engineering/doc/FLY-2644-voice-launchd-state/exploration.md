# FLY-2644 voice launchd state 识别 — 探索
Issue: FLY-2644 (https://linear.app/geoforge3d/issue/FLY-2644/2598follow-up-install-voice-launchdsh-%E6%B0%B8%E8%BF%9C%E5%9B%9E%E6%BB%9A-voice-loaded-identity-%E8%A6%81%E6%B1%82)
日期: 2026-09-16
基于: 无

## 现象

`scripts/install-voice-launchd.sh` 已成功 bootstrap `com.flywheel.voice`，wrapper 也已写入 bootId 并进入 Node CLI；但是安装器在十次观察后仍报告没有看到 running PID，随后执行条件回滚。

主机证据显示同一份 `launchctl print gui/501/com.flywheel.voice` 输出包含三个 `state =`：顶层 `running`，以及两个嵌套结构中的 `active`。当前 `_voice_loaded_identity` 的通用 `field()` 要求字段全局唯一，因此无法返回顶层 state。

## 边界

- 只修安装器对已加载单元身份与运行状态的读取。
- 保留 path、program、arguments、PID 和 plist fingerprint 的既有失败关闭语义。
- 不改变 KeepAlive 形状，不绕过 FLY-913 部署护栏。
- 不执行主机安装、bootstrap、bootout、部署、重启或真实语音房间验证。

## 成功条件

1. 真实形状夹具含顶层 `state = running` 和两行嵌套 `state = active` 时，安装成功且不回滚。
2. 顶层 state 非 running 时，即使嵌套 state 为 active，仍失败并保持既有条件回滚。
3. 现有安装、重复执行、冲突、替换和并发测试继续通过。
