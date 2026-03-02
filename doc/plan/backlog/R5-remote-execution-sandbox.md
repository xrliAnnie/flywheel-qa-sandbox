# Research Plan R5: 沙箱隔离 + Remote Mac Execution 评估

> 优先级：🟢 Low
> 影响 Phase：Phase 3+
> 输入：`doc/exploration/new/v0.2-trending-repo-survey.md`（OpenSandbox 部分）
> 预期产出：`doc/research/new/007-remote-execution-eval.md`

## 目标

评估 Flywheel 从本地 Mac 扩展到 remote Mac 执行的方案，包括 OpenSandbox 沙箱隔离和 remote session 管理。

## 研究任务

### 1. 深入分析 OpenSandbox

- 读取 `/tmp/OpenSandbox/` 源码
- 重点分析：
  - TypeScript SDK（`@alibaba-group/opensandbox`）的 API surface
  - Docker 注入机制（execd binary via volume mount）
  - Claude Code 示例（`examples/claude-code/main.py`）
  - macOS 兼容性限制（egress 控制仅 Linux）
- 评估：能否在 Mac 上运行？是否需要 Linux 中间层？

### 2. 评估 Remote Mac 执行方案

对比以下方案：

- **SSH + tmux attach**：最简单，直接 SSH 到 remote Mac 启动 tmux session
- **OpenSandbox + Docker**：沙箱隔离，但 macOS Docker 性能问题
- **Tailscale + tmux**：私有网络 + tmux，零配置 VPN
- **Claude Code SDK remote**：通过 API 调用远程 Claude Code instance

### 3. 安全性评估

- 代码隔离：不同 project 的 session 互不影响
- Secret 管理：remote Mac 上的 API keys、git credentials
- Network：egress 控制（哪些 URL 可访问）

### 4. 运维考虑

- Session 监控：如何远程监控 tmux session 状态
- 故障恢复：remote Mac 重启后的 session 恢复
- 日志收集：remote session 的日志如何回传

## 产出

### 主要文件
- `doc/research/new/007-remote-execution-eval.md` — Remote execution 方案评估

### 文件内容要求
1. **方案对比表** — SSH+tmux vs OpenSandbox vs Tailscale vs SDK
2. **推荐方案** — 当前最实际的选择 + 理由
3. **安全模型** — 隔离、secret 管理、network 控制
4. **OpenSandbox 适用性** — macOS 限制、workaround、是否值得采用
5. **Migration path** — 从本地 Mac → single remote Mac → multiple Macs

## 参考资料

- `/tmp/OpenSandbox/`（已 clone）
- `doc/exploration/new/v0.2-trending-repo-survey.md`
- 当前 Flywheel 架构（本地 Mac + tmux）
