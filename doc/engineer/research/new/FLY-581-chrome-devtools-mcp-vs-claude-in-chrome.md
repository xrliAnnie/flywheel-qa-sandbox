# Research: Chrome DevTools MCP 全局安装 + vs Claude-in-Chrome 评估 — FLY-581

**Issue**: FLY-581 ([infra] 全局安装 Chrome DevTools MCP + 评估能否替代 Claude-in-Chrome)
**Date**: 2026-06-25
**Source**: Linear FLY-581 / 参考 https://developer.chrome.com/blog/chrome-devtools-mcp

---

## TL;DR（给 Annie 的一句话）

- ✅ **已全局安装** `chrome-devtools-mcp`（官方 Google Chrome 的 MCP，免费），所有新 lead/runner/session 自动可用。
- ✅ **真机端到端验证通过（8/8）**：连真 Chrome、导航 / 读 DOM / 跑 JS / 读 console / 读 network / 截图全跑通，有截图+日志为证（不是只装上）。
- 🟰 **结论 = 互补，不是替代**（最终你定）。`chrome-devtools-mcp` 在 **DevTools 级能力**（性能 trace / Lighthouse / 内存 heap / headless 确定性自动化 / 跨 backend 可移植）上更强；但 **Flywheel 现在 QA 的核心场景 = 在你真实登录态 Chrome 里测 Discord**，那个场景仍然只有 **Claude-in-Chrome** 能直接做（它驱动你本人登录的 Chrome；chrome-devtools-mcp 默认开一个全新、没登录任何东西的隔离 Chrome）。
- 👉 建议：**两者都留**。把 chrome-devtools-mcp 当全 fleet 的标准 DevTools/性能/headless 工具（现已可用），Claude-in-Chrome 继续当「founder 真登录态 QA」后端。**不动现有 QA 流程**。

---

## 1. 装了什么 / 怎么装的（全局安装）

### 1.1 安装位置 = 全局 user-scope MCP 配置

加到 `~/.claude.json` **顶层** `mcpServers`（就是现有 5 个全局 MCP —— pencil / linear-api / bambu-h2d / xiaohongshu-mcp / audible —— 所在的同一处）：

```json
"chrome-devtools": {
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@latest"]
}
```

- 官方推荐格式（见 https://github.com/ChromeDevTools/chrome-devtools-mcp）。`npx -y` = 免单独全局 npm 安装、每次拉最新、零维护。
- **只 ADD 这一项**，5 个现有原样保留，改完是合法 JSON。改前备份在 `~/.claude.json.bak-pre-fly581`（一键回滚）。

### 1.2 为什么这一处 = 真·全局（传播到所有 lead/runner）

| 消费方 | 怎么拿到 | 生效时机 |
|--------|----------|----------|
| 主 Claude Code session（含本 runner） | 直接读 `~/.claude.json` 顶层 `mcpServers`（user scope） | **新 session 立即** |
| 所有 dept Lead（非 companion） | `claude-lead.sh` 经 `lib/mcp-inherit.sh` 的 `build_user_mcp_fragment` 把 `~/.claude.json` 顶层 `mcpServers` 继承进 Lead 的 `.mcp.json` | **下次 Lead 重启才生效**（不为这个单独重启 fleet） |
| Runner | Runner 的 `claude` CLI 同样读 user-scope `mcpServers` | **新 Runner 立即** |
| Companion Lead（Mufasa / Belle） | `claude-lead.sh` 对 companion 显式 **不继承任何 user-scope MCP**（`USER_MCP_FRAGMENT='{}'`） | 不下发（设计如此，陪伴型 Lead 不做浏览器 QA） |

> 关键点：`mcp-inherit.sh` 的信任模型 **只读顶层 `~/.claude.json.mcpServers`，永不读 `projects[*].mcpServers`**（后者带 per-project secret）。所以「全局」唯一正确落点就是顶层。`chrome-devtools` 不在 reserved（`flywheel-terminal,flywheel-inbox,gbrain`）也不在 blacklist（`audible`），且无 required `${VAR}` env，故会被干净继承。

### 1.3 一个发现（不影响本次安装）

本机其实早已 `npm` 全局装了 `chrome-devtools-mcp`（`~/.npm-global/bin/chrome-devtools-mcp`），且 `~/.claude.json` 里有一条 **project-scoped** 旧条目挂在 `projects["/Users/xiaorongli/Dev"].mcpServers`（用 bare `command: "chrome-devtools-mcp"`，非 npx）。但 project-scoped 只在 cwd 恰好是 `/Users/xiaorongli/Dev` 时才生效，**不满足全 fleet 共享**。该旧条目本次 **未改动**（scope discipline，无害）。我新加的顶层条目才是真全局。

---

## 2. 真机端到端验证（= 真能用，不只装上）

用一个裸 MCP-stdio harness 直接驱动 server（不依赖任何特定客户端），对真 Chrome 跑完整链路。harness 源码：`doc/engineer/research/assets/FLY-581-cdmcp-verify.mjs`（可复跑）。

**环境**：Node v25.6.1 · Chrome 149.0.7827.197 · `chrome-devtools-mcp@latest` = **v1.4.0** · 启动参数 `--isolated --headless`（= 它自己开的隔离 Chrome）。

| # | 能力 | 调用 | 结果 | 证据 |
|---|------|------|------|------|
| 1 | MCP 握手 | `initialize` | ✅ PASS | serverInfo `chrome_devtools` v1.4.0, protocol 2025-06-18 |
| 2 | 工具面 | `tools/list` | ✅ PASS | **29 个工具** |
| 3 | **导航** | `new_page {url:https://example.com}` | ✅ PASS | `Pages 2: Example Domain (https://example.com/) [selected]` |
| 4 | **读 DOM** | `take_snapshot` | ✅ PASS | a11y 树含 `RootWebArea "Example Domain"` + heading + StaticText |
| 5 | 跑 JS | `evaluate_script` | ✅ PASS | 返回 `"Example Domain \| h1=Example Domain"` |
| 6 | **读 console** | `list_console_messages` | ✅ PASS | 抓到注入的 `[log] FLY-581-VERIFY-<ts>` |
| 7 | **读 network** | `list_network_requests` | ✅ PASS | `GET https://example.com/ [200]` |
| 8 | **截图** | `take_screenshot {filePath}` | ✅ PASS | 真 PNG 1200×2029, 59872 bytes, magic 正确 |

**SUMMARY 8/8 passed。** 截图实拍（example.com 真渲染）：

![chrome-devtools-mcp 真机验证截图](../assets/FLY-581-chrome-devtools-mcp-verify.png)

> 复跑：`node doc/engineer/research/assets/FLY-581-cdmcp-verify.mjs /tmp/out.png`

---

## 3. chrome-devtools-mcp vs Claude-in-Chrome 对比

### 3.1 连接模型（**最关键的区别**）

| | chrome-devtools-mcp | Claude-in-Chrome |
|---|---|---|
| 默认驱动的浏览器 | **它自己开的全新隔离 Chrome**（fresh profile `~/.cache/chrome-devtools-mcp/chrome-profile-*`），**没登录任何账号** | **你本人正在用的真 Chrome**，带你所有登录态（Discord 等） |
| 实现机制 | Puppeteer + Chrome DevTools Protocol（CDP），标准 MCP（stdio） | Anthropic 第一方「Claude for Chrome」**浏览器扩展** + 配套桥（`~/.claude/chrome`） |
| 接已开的真 Chrome？ | 可以，但要么 `--browser-url=http://127.0.0.1:9222`（需 Chrome 以 `--remote-debugging-port` 启动），要么 `--autoConnect`（Chrome 144+，需用户授权）—— 都是**额外启动方式 + 安全权衡** | 天然就是你的真 Chrome，零额外设置 |
| headless | 支持（`--headless`） | 否（就是你看得见的窗口） |

> 这条决定了一切：Flywheel QA 反复强调「**必须用 Claude-in-Chrome、不能用 Playwright，因为没有 Annie 的 Discord session**」。chrome-devtools-mcp 默认那个隔离 Chrome 同样**没有** Annie 的 Discord 登录，所以对「在真登录态里测 Discord」这个主场景，开箱即用是做不到的。

### 3.2 能力覆盖

**两者都有**：导航、读页面/DOM、截图、读 console、读 network、表单输入、跑 JS、文件上传。

| 只有 chrome-devtools-mcp（DevTools 级） | 只有 Claude-in-Chrome |
|---|---|
| 性能 trace（`performance_start/stop_trace` + `analyze_insight`） | 驱动**真登录态** Chrome（核心价值） |
| Lighthouse 审计（`lighthouse_audit`） | `computer` 工具：基于视觉的像素级点击/输入（canvas / 非 DOM 也能操作） |
| 内存 heap snapshot（`take_heapsnapshot`，含 dominators/retainers） | `gif_creator`：操作录制成 GIF |
| 设备/网络/CPU 节流模拟（`emulate`） | 多浏览器 `select/switch_browser` |
| **标准 MCP → 任何 backend（Codex/Antigravity/Kimi…）都能用** | Claude 原生视觉：模型「看得见」页面 |
| 确定性 headless 自动化（适合 CI 式可复现） | — |

（chrome-devtools-mcp v1.4.0 实测 29 工具；旧文档说的「47+」含实验性/扩展/WebMCP 工具，本 stable 版未全开。）

### 3.3 可靠性

- **chrome-devtools-mcp**：CDP/Puppeteer，结构化文本输出（a11y 快照、console/network 都是文本），每次隔离 session → **确定、可复现、可 headless、可脚本化**。适合 CI 式回归。
- **Claude-in-Chrome**：依赖扩展已装/已配权限 + 真 Chrome 的实时状态（tab/焦点）+ Claude 视觉解读 → **更像真人、但更易受真实页面状态影响**，变量更多。

### 3.4 成本

- 两者对 Annie **都是免费**（chrome-devtools-mcp 开源/npm；Claude-in-Chrome 是 Claude 订阅自带，无 per-token 账单 —— 项目本就 "Cost tracking N/A, Claude subscription"）。
- 间接 token 效率：chrome-devtools-mcp 返回**文本快照**（比 Claude-in-Chrome 的「截图→视觉」回路省视觉 token）；但 Claude-in-Chrome 的视觉理解在「页面没有干净 DOM/canvas 重」的场景更顶用。
- 运行开销：chrome-devtools-mcp 每次会拉起一个 Chrome 进程（RAM/CPU）。

### 3.5 安装 / 维护成本

| | chrome-devtools-mcp | Claude-in-Chrome |
|---|---|---|
| 安装 | 一行 npx 进全局 MCP 配置（已完成） | 装 Claude for Chrome 扩展 + 配对 + 在扩展里配站点权限 |
| 维护 | `@latest` 自动更新，Google 维护，≈零 | 跟随 Anthropic/扩展，已在 Flywheel 中实战稳定 |
| 可移植性 | **标准 MCP，任何 MCP 客户端通用**（对 Flywheel 的多 backend 方向 = Codex/Antigravity/Kimi runner 很关键） | **只能配 Claude**（非 Claude backend 用不了） |

---

## 4. 能否替代 Claude-in-Chrome？（结论 — Annie 定）

**简短回答：不能直接替代，定位互补。**

- ❌ **不替代** Flywheel 当前主 QA 场景（founder 真登录态下测 Discord/真站点）：那需要 Annie 真 Chrome 的登录 session，**只有 Claude-in-Chrome 开箱能做**。chrome-devtools-mcp 默认隔离 Chrome 没登录态；要它接真 Chrome 得让 Annie 的 Chrome 用 `--remote-debugging-port` 启动 + `--browser-url` 连 —— 这是**额外设置 + 安全权衡**（官方警告：开了 remote debugging 端口，本机任何程序都能连上控制该浏览器），**不建议默认这么干**。
- ✅ **新增并补强**这些 Claude-in-Chrome 做不到的：性能 trace / Lighthouse / 内存 heap / 设备节流模拟 / 确定性 headless 回归 / **给非-Claude runner（Codex/Antigravity/Kimi）唯一的浏览器能力**。

**给 Annie 的建议（你拍板）：两者都留。**
1. chrome-devtools-mcp = 全 fleet 标准 DevTools / 性能 / headless 自动化工具（现已全局可用）。
2. Claude-in-Chrome = 继续做「founder 真登录态 QA」后端，**不动现有 QA 流程**。
3. 若将来想让 chrome-devtools-mcp 也做真登录态 QA → 单独评估那条 `--browser-url` 路径的安全设置（不在本 issue 范围）。

---

## 5. 安全说明（来源可信 + 安装方式记录）

- **来源可信**：`chrome-devtools-mcp` 由官方 **Google Chrome DevTools 团队**维护（GitHub org `ChromeDevTools`，对应 https://developer.chrome.com/blog/chrome-devtools-mcp）。免费、开源。本次走免费路径，无任何付费方案。
- **能力面**：装全局 MCP = 全 fleet 非-companion agent 拿到 browser-devtools 能力（issue 明确要求「让所有 lead/runner 都能用」）。官方提示：该 MCP「会把浏览器内容暴露给 MCP 客户端，可读/改浏览器或 DevTools 里任何数据 —— 别在里面放敏感信息」。因默认是隔离 fresh-profile Chrome，**默认不接触 Annie 的真登录态**，安全面是收敛的。
- **回滚**：删掉 `~/.claude.json` 顶层 `mcpServers.chrome-devtools` 即可（或从 `~/.claude.json.bak-pre-fly581` 还原顶层那段）。
- **不改生产行为**：只新增工具面，未改任何现有 flow / QA 流程；现有 Lead 要下次重启才看到（不为此单独重启 fleet）。

---

## Appendix A — chrome-devtools-mcp v1.4.0 全部 29 工具

`click, close_page, drag, emulate, evaluate_script, fill, fill_form, get_console_message, get_network_request, handle_dialog, hover, lighthouse_audit, list_console_messages, list_network_requests, list_pages, navigate_page, new_page, performance_analyze_insight, performance_start_trace, performance_stop_trace, press_key, resize_page, select_page, take_heapsnapshot, take_screenshot, take_snapshot, type_text, upload_file, wait_for`

## Appendix B — 连接其它方式（仅记录，未启用）

- `--browser-url=http://127.0.0.1:9222` — 连一个以 `--remote-debugging-port=9222` 启动的 Chrome
- `--autoConnect` — Chrome 144+ 用户授权后自动发现本机 Chrome
- `--isolated` — 临时 profile，退出即清（本次验证用）
- `--headless` / `--channel` — 无头 / 指定 Chrome 渠道
