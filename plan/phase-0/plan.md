# Phase 0 — 环境验证 + 单 pane 检测 + TTS 播报

> **Related overview sections**: [Section 3 (架构)](../overview.md#3-系统架构), [Section 6 (tmux 集成)](../overview.md#6-tmux-集成细节), [Section 7 (语音交互)](../overview.md#7-语音交互设计), [Section 8 (提示解析)](../overview.md#8-提示解析策略)

## 目标

验证环境可行性 + tmux capture-pane → 解析 → TTS 播报链路

## MVP 边界

**Phase 0-1 交付 MVP：** 手动配置 1-3 个 pane + 数字/yes-no 语音回写 + 基础日志。

**不属于 MVP：** 自动发现、复杂启发式、needs_attention 兜底、日志轮转、macOS 通知、热重载。这些归入 Phase 2-3。

## Tasks

### Preflight Checklist（必须全部通过才能继续）

1. Hammerspoon 已安装且能运行 Lua 脚本
2. 麦克风权限已授予 Hammerspoon（`hs.microphoneState()` 返回 true，否则触发 `hs.microphoneState(true)` 请求授权）
3. `hs.speech.listener` 后台识别可用：设置 `foregroundOnly(false)` 后切到其他 app，确认仍能识别命令
4. 音频设备测试：TTS 通过当前耳机/扬声器正常播放；切换蓝牙耳机后仍正常
5. tmux 可达：`hs.execute("tmux list-sessions")` 能正常返回
6. `tmux capture-pane -t <test_pane> -p -S -50` 能正常返回内容

### 中文词表 Gate（Phase 0 硬性验证）

7. 注册中文命令词（"选一"/"选二"/"稍后"等），测试识别率
8. **通过标准：** 安静环境下 10 次测试 >= 8 次正确识别
9. **未通过：** MVP 仅使用英文词表（"one"/"two"/"later"等），中文降为 Phase 4 可选增强

### 真实样本采集

10. 在 Claude Code 中触发 10+ 种不同的选择提示
11. 用 `tmux capture-pane -p -S -50` 保存每次输出到 `~/.claude/voice-loop/samples/`
12. 基于真实样本校准 parser 正则规则（而非凭假设写 pattern）
13. 建立样本回归测试集（所有新 pattern 必须通过全部样本）

### 模块实现

14. 创建 `~/.hammerspoon/voice-loop/` 目录结构
15. 实现 `monitor.lua`：定时 capture-pane 指定 pane
16. 实现 `parser.lua`：基于真实样本的正则匹配
17. 实现 `tts.lua`：`hs.speech` 封装，播报模板
18. 配置文件：手动指定一个 pane target + alias
19. 端到端测试：在 pane 中 echo 模拟提示 → 听到播报

## 验收标准

- Preflight 全通过
- 在一个指定 pane 中出现选择提示后 **< 3 秒**听到语音播报
- 中文词表 gate 结果记录（通过或未通过，附测试数据）
- 至少 10 个真实 capture-pane 样本已采集并归档

## 预计工作量

约 6-8 小时（含 preflight 和样本采集）
