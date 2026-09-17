# FLY-2551 小红书批准门 — 验收审计
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-15
基于: plan.md

## 尚未闭合：user_profile 与旧 MCP

Lead 对问题 `dfbaf995-4776-4117-8fef-0a6474510e4e` 的裁定：暂缓 user_profile cutover；不得伪造 profile-page fixture。保留旧 MCP 的 user_profile 路径，等待 Lead 与 founder 浏览器独立采集真实页面证据。若廉价可改为首次调用时懒连接，否则允许保留现有 eager 连接。

当前 `runtime-factory.ts` 先调用 startXiaohongshuProvider，再用 authority handler 覆盖八个读取动作；authority 配置可用时，仅 user_profile 仍执行旧 MCP handler。此轮保留已有 eager 连接。没有取得真实 profile-page capture，没有把 feed token 或 basicInfo.redId 当作用户授权来源。不得将当前实现描述为所有九读迁移完毕、旧凭据已撤销或旧 MCP 已退休。

该缺口由 Lead 负责后续采集；实际 follow-up issue 编号尚未提供。没有执行真实浏览器或账号动作。

## 全阶段验收仍未完成

本文件只记录已核实的缺口与裁定，并非完整验收清单或通过回执。authority 主入口与生命周期装配、登录失败恢复、受控媒体接线、Claude/Bridge 集成、独立 UID/root 安装与真实隔离验收、完整验证门、有效代码评审及两个 PR 仍需闭合。已完成的模块级证据见 implementation-evidence.md。

## 媒体与主入口的当前边界

1812d709b 已接入authority-main/bootstrap/service，但没有真实daemon启动及信号退出验收。媒体validator和artifact store已装配，媒体导入入口仍未接；当前attachmentLimit仅为10MiB硬上限，目标guild实测附件限额回执及取较小值尚缺。不得把包构建与受控替身测试视为安装、Discord或主机验收。

## 附件探针当前权威裁定

Lead cdb6da8d-d754-4c27-9af7-1386a5e9535c及更正42071685-e07d-4b87-8687-13b664c86c30：自动探针仅去root配置指定、目标guild中的专用非用户频道，做upload/readback/delete；private stateRoot内authority-owned 0600回执绑定guild/channel/时间/expiry。回执只能降低独立10MiB硬上限；缺失、失败、过期或绑定不符回退10MiB，激活不因此阻断。不要求root writer或人工回执。本轮只实现与fake Discord验证；真实探针由QA在529房间运行。探针和缓存尚未实现，真实证据尚未获得。

## 2026-09-15 当前source进度更新

前述“尚未实现/接入”的条目反映其记录时点。现在主入口、受控图片/视频登记与上传、prepare的authority ID转换、探针及私有缓存均已有source接线。ed3c1557e已接root专用probe频道、后台poll及导入/发卡scope限额；40项定向测试与tsc通过。真实DiscordSource探针fake HTTP组合、真实测量回执、安装/独立UID/主机验证及其余完整工作流验收仍未完成。不得据此声称QA529探针已执行。

## Claude legacy user_profile ruling — 2026-09-15

Lead答复3163d0c7-f3f5-4948-b3eb-e6d6b5f44b8f明确选择兼容方案1：Claude继续原样继承raw xiaohongshu-mcp，等待founder-owned真实profile capture；本PR交付additive8 authority reads +4 receipt writes。不实现Claude专用legacy token adapter，不允许model-supplied xsec_token passthrough，不伪造fixture。user_profile的authority activation/acceptance必须保持fail closed，不能把现有legacy路径作为该验收项通过证据。

范围限制：保留raw MCP意味着其原有写工具仍可能出现在模型工具清单里；该裁定没有豁免计划要求的provider写入口拒绝、旧session撤销、真实OS隔离/host验收。新增guarded facade的源代码/测试绿不能证明旧写旁路已关闭。真实账号、browser、host变更均未授权/未执行；独立capture和host activation仍待可信后续流程。

## 2026-09-15 parent staging 遗留目录裁定（待实施）

审计确认 XhsBridgeArtifactRegistry 目前仅内存记录 dev/inode 与256MiB计数；Bridge 崩溃后旧 `.flywheel-xhs-artifact-*` 目录遗留，新进程计数重置。它们属于模型 UID 暂存，不是 authority frozen media。自动信任这些模型可写目录的 manifest 来删除文件不在授权范围。

Lead ruling 910aca94-2078-4456-941a-9df3949e724c 要求：新增 staging 使用 fsynced exclusive project owner marker（Bridge PID/start-time/nonce）；只有证明旧 owner 已死才可接管，活 owner 不得置换。所有未拥有旧目录保留、不删除、不移动、不依赖其 manifest；旧 bytes 计入项目256MiB，旧目录固定小上限（采用8），超限报 `staging_leftovers_exceeded` 并写 Lead 可见日志列出保留路径。当前代码尚未实现该 admission/accounting。

后续 operator 清理路径：先根据日志和只读 stat 确认具体保留目录及所属项目，取得单独清理授权后由受授权操作者处理；本 issue 不提供自动删除或新清理子系统。该遗留 gap 必须继续在验收报告列明，不能把“不再分配”写成“已清理”。

新增 host acceptance：生产入口没有 acceptance 必须拒绝；probe 对非 synthetic 或非 root-owned fixture 必须拒绝。此处仅记录门条件，未执行 host probe。

## 2026-09-15 staging admission source closure

The preceding pending staging integration is now implemented and covered by27 focused tests: owner assertion on reads/writes, retained-byte plus concurrent project reservations, fixed HTTP denial/internal retained-path logging, asynchronous owner release after draining. Old directories remain retained; this is not cleanup. Sandbox process identity uses an explicit test observation seam and supplies no host proof. Boundary probe/installer and final workflow gates remain outstanding; see implementation-evidence.md for red/green receipts.

## Native asset assembly ruling — 2026-09-15

Lead765b2b22-f68b-438c-b0f1-5cbb0a35c8f0 confirmed: use reviewed official nodejs.org macOS Node with exact version/SHA256 pins; fixed Node/addon dependencies must resolve inside the tree or system-only /usr/lib and /System/Library. Reject Homebrew/user paths and escaping rpaths. No install_name_tool/codesign relocation project or general dependency verifier. Native assembly remains fail closed pending compliant pinned distribution.

Read-only observed loader evidence for the rejected current host Node (no root execution or installation):

```text
/opt/homebrew/Cellar/node/25.6.1/bin/node:
	@rpath/libnode.141.dylib (compatibility version 0.0.0, current version 0.0.0)
	/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)
	/opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib (compatibility version 9.3.0, current version 9.3.0)
	/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)
	/opt/homebrew/opt/ada-url/lib/libada.3.dylib (compatibility version 3.0.0, current version 3.4.2)
	/opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib (compatibility version 29.0.0, current version 29.0.0)
	/opt/homebrew/opt/brotli/lib/libbrotlidec.1.dylib (compatibility version 1.0.0, current version 1.2.0)
	/opt/homebrew/opt/brotli/lib/libbrotlienc.1.dylib (compatibility version 1.0.0, current version 1.2.0)
	/opt/homebrew/opt/c-ares/lib/libcares.2.dylib (compatibility version 2.0.0, current version 2.19.5)
	/opt/homebrew/opt/hdrhistogram_c/lib/libhdr_histogram.6.dylib (compatibility version 6.0.0, current version 6.2.3)
	/opt/homebrew/opt/libnghttp2/lib/libnghttp2.14.dylib (compatibility version 44.0.0, current version 44.2.0)
	/opt/homebrew/opt/libnghttp3/lib/libnghttp3.9.dylib (compatibility version 9.0.0, current version 9.6.1)
	/opt/homebrew/opt/libngtcp2/lib/libngtcp2.16.dylib (compatibility version 24.0.0, current version 24.3.0)
	/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib (compatibility version 9.0.0, current version 9.6.0)
	/opt/homebrew/opt/uvwasi/lib/libuvwasi.dylib (compatibility version 0.0.0, current version 0.0.0)
	/opt/homebrew/opt/zstd/lib/libzstd.1.dylib (compatibility version 1.0.0, current version 1.5.7)
	/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib (compatibility version 3.0.0, current version 3.0.0)
	/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.0.0)
	/opt/homebrew/opt/icu4c@78/lib/libicui18n.78.dylib (compatibility version 78.0.0, current version 78.2.0)
	/opt/homebrew/opt/icu4c@78/lib/libicuuc.78.dylib (compatibility version 78.0.0, current version 78.2.0)
	/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3423.0.0)
	/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.101.1)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.178.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
```

This output proves copying the executable alone is insufficient: its absolute Homebrew dependencies and libnode rpath remain outside the fixed manifest tree. The offline JS runtime builder does not copy this Node.
