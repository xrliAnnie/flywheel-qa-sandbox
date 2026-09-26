# FLY-2886 语音后台真宿主起 parent — 实现期验证记录
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权自己动手-动作日志回-lead-记忆与上下文三层装载)
日期: 2026-09-26
基于: plan.md v12 §14

本文件记录 plan §14.3 在真宿主上实测时发现、并按 Lead 答复（问询 `0feb0514`、`a94a6f30`）处理的沙箱问题。全部实验在本机跑，用真 codex（`~/.flywheel/codex-standalone/0.156.1/bin/codex`，sha256 `0196e89f…255a`；对照 0.153.2）和真 Homebrew node 25.6.1（`/opt/homebrew/Cellar/node/25.6.1/bin/node`）。没有碰生产 Bridge / Lead / 529 房。

## 1. node 运行时闭包：软链接节点只能按所在目录放行

**现象**：plan 原方案「只放精确文件（字面路径 + realpath）」下，沙箱内 node 仍 exit 134：`Library not loaded: /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib … (blocked by sandbox)`。`@rpath/libnode` 已能加载，挡住的是经软链接的依赖。

**受控实验**（自建 `realdir/real.txt`、`realdir/link.txt → real.txt`、`d/dirlink → ../realdir`，沙箱内 `cat`）：

| 放行 | 读的路径 | 结果 |
|---|---|---|
| link.txt | real.txt | 0（放行 link 路径 = 放行了目标） |
| link.txt | link.txt | EPERM |
| real.txt | link.txt | EPERM |
| real.txt + link.txt | link.txt | EPERM |
| realdir | d/dirlink/real.txt | EPERM |
| realdir + d | d/dirlink/real.txt | 0 |
| real.txt + d | d/dirlink/real.txt | 0 |

结论：codex 把权限档路径一律 realpath 化，软链接节点本身无法按路径放行；Seatbelt 查找时又要检查这个节点。**唯一可行的是放行链接所在的 canonical 目录。**

**处置**（Lead 同意）：放行 realpath 精确文件 + 解析链实际经过的每个软链接所在目录（只读）。守卫：目录深度 ≥ 3、不能是 HOME 或其祖先、文件 + 目录总数 ≤ 64。本机结果 22 个文件 + 12 个目录（`/opt/homebrew/opt` 与 11 个 `Cellar/<pkg>/<ver>/lib`），见 `evidence/v12-host-isolation-green.txt`。清单逐条记录：parent 返回 `nodeRuntimeClosure {files, directories}`；常驻由 Lead logger 打 `Codex Lead sandbox node runtime grants`，语音写 evidence `codex_voice_node_runtime_closure`。

## 2. `:tmpdir` deny 把模型自己的 scratch 拒写

**现象**：探针 `writable` 恒为 false。沙箱内实测：project 下预建的普通目录、点目录都可写，唯独 `modelTempRoot` 不可写。

**原因**：权限档 `":tmpdir": "deny"`，而 `buildLeadModelEnv` 把 `TMPDIR` 固定为 `modelTempRoot`；codex 按子进程的 `TMPDIR` 解析 `:tmpdir`，于是拒掉了模型自己的 scratch。两处都来自 #1191，常驻同病。

**处置**（Lead 同意）：删掉 `:tmpdir` 条目。宿主真 tmp 仍被 `:root` deny 拒：同一探针 `writeDenied`（写宿主 `$TMPDIR` 下的文件）仍为 true，`writable`（模型 scratch）变为 true。

## 3. 网络出口：codex 托管代理与 Flywheel egress

**现象**：探针 `proxyAllowed`（直连权限档 `proxy_url` 端口）恒为 false：沙箱内连该端口 EPERM。codex 0.153.2 / 0.156.1 的 `sandbox` 都自起托管代理（临时端口），在子进程 env 里把 `HTTP_PROXY` 等指向它，且只放行连它。

**出网矩阵**（沙箱内 `curl`，原件 `evidence/v12-egress-matrix-0.156.1.txt`、`-0.153.2.txt`；权限档现状 `allow_upstream_proxy=false`）：

| 目标 | 结果 |
|---|---|
| https / http 公网（example.com） | 200 |
| 127.0.0.1、localhost 上的本地服务 | 403 |
| 解析到 127.0.0.1 的域名（localtest.me、127.0.0.1.nip.io） | 403 |
| 169.254.169.254（元数据） | 403 |
| 10.255.255.1、192.168.1.1 | 403 |
| 解析到 10.x 的域名（10.0.0.1.nip.io） | 403 |
| 绕过代理直连公网 | DNS 解析被拒 |
| 绕过代理直连回环 | connect 被拒 |
| Flywheel egress 收到的请求数 | **0** |

结论：托管代理**不经** Flywheel egress，直连公网；但它自己的策略与 Flywheel egress 等价（公网放行、私网/回环/链路本地/解析到私网的域名全拒）。

**对照（方案 B）**：权限档 `allow_upstream_proxy=true`，codex 进程 env 的 `HTTP(S)_PROXY`/`ALL_PROXY` 指向 Flywheel egress。结果（`evidence/v12-egress-matrix-upstream-0.156.1.txt`）：同一矩阵结论不变，**Flywheel egress 收到 5 个请求**（2 个公网放行 + 3 个解析到私网的域名被它 403）；codex 自己那层仍拦 IP 字面量。

**Lead 裁定（问询 `a94a6f30`）：选 B**，常驻同修，并要求上游链证明与常驻回归测试。

**实现**：

- 权限档 `allow_upstream_proxy = true`；pins 增加 `egressProxyUrl = http://127.0.0.1:<proxyPort>`，`buildLeadModelEnv` 据此给 codex 进程 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（codex 给沙箱子进程另设自己的托管代理，模型命令拿不到 Flywheel egress 的直连地址）。TUI 绑定语法接受这三个键，值必须是 `http://127.0.0.1:<port>`。
- 上游链证明：codex 托管代理自己先做 DNS 解析，只把解析到公网的主机转发上游（实测 `.invalid` 与不存在的子域在 codex 层即 403、Flywheel egress 计数 0），所以探测 URL 用可公网解析的 `http://example.com/.well-known/flywheel-egress-probe/<nonce>`。Flywheel egress 在任何解析/上游访问之前按这个精确前缀截获、回 204、记下 nonce（最多 64 个，读一次即消费）。探针经沙箱 `HTTP_PROXY` 请求它，必须得到 204，且 `verifyModelIsolation` 事后必须在 egress 那边查到同一 nonce，否则 `model_isolation_unproven`。绕过 egress 的请求只会打到真实 example.com，永远记不上。
- 代价（诚实边界）：parent 启动时的隔离证明需要能解析 example.com（公网 DNS）；离线宿主上语音后台降级、常驻 parent 起不来。

**真宿主回归**（`evidence/v12-host-isolation-green.txt`，host 用例）：

| 用例 | 结果 |
|---|---|
| 旧配置（无上游、无 proxy env）与新配置跑同一出网矩阵 | 逐目标结果完全相同：公网 200；回环、localhost、解析到回环/10.x 的域名、169.254.169.254、10/8 全 403；直连公网与回环都失败（000） |
| 两种配置下 Flywheel egress 看到的主机 | 旧：无；新：只有 `example.com` |
| `verifyModelIsolation`（真 codex 0.156.1 + 真 Homebrew node + 常驻形状权限档 + 真 Flywheel egress） | 通过 |
| 同上但托管代理不链上游（`allow_upstream_proxy=false`） | `model_isolation_unproven`（探针能抓到绕过） |

## 4. 本机真宿主起语音 parent（QA-R1 前置预演）

脚本与输出：`evidence/v12-real-host-parent/`。条件：真 codex 0.156.1、真 Homebrew node、**零 provider 桩**；临时 HOME（`deployed-sha` = 本分支 HEAD）与临时 projects.json（flywheel-eng-lead，`voiceBackground {enabled, browser: off}`），`authSourcePath` 直指生产 `~/.codex/auth.json`（容器 home 里是软链接，inode 与真源一致，零副本）；无 `LINEAR_API_KEY`、无 gh 登录、无 gbrain 配置；Bridge 指向不可达地址（parent 启动不调 Bridge）。

| 判据 | 结果 |
|---|---|
| `startVoiceCapabilityParent` | 1.75s 成功，70 个操作 |
| `unavailableIntegrations` | context7=`baseline_drift`、gbrain=`host_config_unverified`、github=`credential_missing`、linear=`credential_missing`；xiaohongshu-mcp 已接上 |
| `verifyModelIsolation`（真 Homebrew node + 上游链证明） | 通过（parent 启动内执行） |
| 用该 parent 起 capability app-server | 1.5s 起来；`account/read` = `chatgpt`；有效配置与权限档核过；技能核过 |
| 模型侧 MCP | `lead_actions` 在沙箱内起来，`tools/list` = `lead_operation` |

**新发现：`codex_apps`**。ChatGPT 订阅账号下 codex 会自动注入一个 `codex_apps` MCP 服务器（52 个工具：sites 部署、plugin 管理、parental controls 等）。它不在 Flywheel 能力清单里、不经 broker、不留回执，而且会让 container 的服务器集合断言失败（准入在真宿主必降级）。处置：语音 capability 进程启动参数加 `-c features.apps=false`（scribe 早已如此）；实测加上后只剩 `lead_actions`，配置与技能照样核过（`appserver-apps-off.json`）。常驻 capability app-server 是否同样被注入未核实，列入 PR Follow-ups。

未覆盖（归 529 房 QA）：有 Linear key 的一场、完整语音会话（realtime 需 API key）、后台读/写与 founder 门、浏览器模式。
