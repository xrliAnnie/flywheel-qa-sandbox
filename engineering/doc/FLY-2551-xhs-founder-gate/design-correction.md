# FLY-2551 launchd 监听身份 — 实施计划修正
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-15
基于: plan.md

## 根监听器身份

Lead ruling c91e5ce1-1c5f-4ed2-81c5-cd5ff120094c 批准公共入口的限定修正。
本机 macOS 26.6 `getpeereid(3)` DESCRIPTION 说明：连接方观察到的是服务端调用 `listen(2)` 时的有效身份；接受方观察到客户端调用 `connect(2)` 时的身份。`launchd.plist(5)` 的 `Sockets / SockPassive` 默认 true，由 launchd 执行 listen。`SockPathOwner` 只指定 socket 文件属主。因此 root launchd 创建、随后交给专用 UID 的监听 fd，其客户端 peer 应固定为 root，不能要求为专用 UID。

来源为本机系统手册，可复核：`man 3 getpeereid`、`man 5 launchd.plist`。这是系统语义和源码审计证据，尚未执行真实 root launchd 验收。

公共 ingress 的三类工厂（Codex parent、Bridge notifications、Bridge read/write）固定配置 `authorityUid: 0`。此配置仅在根策略加载、provider/helper 摘要、签名 acceptance、注册范围、实际模型 UID/组与当前身份校验后创建；每次请求仍复查。路径严格取自根策略，所有祖先必须为 root 所有且无 group/other 写权限；socket 必须 root 所有、指定 ingressGid、0660、单链接且非符号链接。没有新增握手或通用 root-peer 绕过。服务端客户端 UID 校验及专用 UID 启动断言不变。

底层传输允许显式的非负 UID，仍精确比较内核 peer。真实普通用户 Unix listener 测试证明：配置 root peer 后不会发送 HTTP。工厂测试证明模型拥有的入口在构造前及重检查时均拒绝。

## 尚未覆盖的私有监听器

私有 fd4 当前位于专用 UID 的 0700 目录，Go 同时要求目录/socket/peer 为专用 UID；上述公共入口修正不能使其可用，也不能作为私有路径授权。Lead ruling e6094db9-bca2-481f-981e-17a295e20107 已确认 root-owned 0750/serviceGid 目录、root-owned 0660/serviceGid socket 与完整根祖先校验后，私有策略固定路径使用 root peer。必须继续继承 fd4，保持 provider 专用 UID/组及 server 实际客户端 UID 校验。私有客户端与启动校验已实施：Go 从已验证的启动策略取得路径和 serviceGid，要求 root-owned 0750 专用组目录及 root-owned 0660 同组单链接 socket，所有祖先 root 不可写且无符号链接；保存目录/socket 身份并在每次拨号前后重新比较。peer 固定为 0。TS authority 启动执行相同布局校验。Go 原有成功协议测试仍用真实用户 listener，但其用户权限校验入口已移至测试夹具，生产启动只能选择根布局工厂。额外实机验收：serviceGid 外的客户端连接 fd4 路径必须 EACCES；Go 客户端拒绝非策略私有路径。

## 实机验收条件

必须分别证明 authority 进程为专用 UID、fd3/fd4 来自 launchd 继承而非自行创建、非策略路径被拒绝。现有本地测试不替代这些验收，也不授权 host 安装或启动。

## Synthetic-only 首次验收引导

Lead ruling 01e2dc6f-c65a-44b3-9cf2-1e72133a1bbb 确认独立 probe entry：它必须自行校验 root-owned fixture root 和显式 synthetic marker，拒绝生产 state 路径、真实账号 key、真实平台/Discord endpoint。不得用生产入口的 flag/env 放宽 acceptance。probe 无签名能力；受信 root 安装器自行读取退出码/回执并测量后签名，不接收模型上传的 passed JSON。

两端根策略现在要求相同的 `boundaryProbe` 路径/摘要 pin；签名 statement 增加必填 `probeSha256`，与根策略 pin 严格比较，并继续绑定 config/provider/schema 摘要。旧的缺 probe 身份回执拒绝。域仍为当前未部署协议的 `flywheel:xhs-boundary:v1`，所有消费端同步要求新字段。实际 fixture-only probe 和 root 安装器签名流程尚待实现，生产 loader 的强制验签没有豁免。

## Fixture harness classification — 2026-09-15

Lead ruling0671478b-e152-427b-a373-311be247fd01 selects the existing browser fixture harness via a separate pinned probe. Do not build a new DNS/TLS fake-XHS host. The eventual fixture launcher must share production service/store/transport modules and differ only in pinned synthetic account and fake Discord/platform adapters. Production startup retains mandatory signed acceptance.

Both signature consumers now require probeKind=fixture_harness in the signed statement. An old statement lacking the classification, or one claiming real_platform, is rejected. This classification is not a replacement for the installer independently measuring dedicated UID, Unix peer identity and inherited listeners on the host. Actual XHS-origin/Chromium behavior remains a separate founder-run installer acceptance item; this probe does not supply it.

The first executable probe supports file-authority only. Its fixture root is fixed to /private/var/db/flywheel-xhs-qa/<64hex nonce>, with immutable root-owned fixture.json and ancestors and a dedicated-service-owned0700 state directory. Marker fields are strictly schemaVersion/purpose/nonce/serviceUid/modelUid; no arbitrary account, endpoint, credential or production path is accepted. The marker admits a synthetic check and is not a passed receipt. Root installer positive controls, shared fixture service launcher, other probes and signing remain pending.

## Native pre-Node bootstrap ruling — 2026-09-15

Lead answer837db97f-6b4d-4a8c-bec5-0ee09cb4f8e9 confirms a root-only native bootstrap verifies the installed tree before exec Node; no existing bootstrap is available. Native manifest is deterministic sorted ASCII text with one entry per line `<sha256> <mode> <uid>:<gid> <relative-path>`, fixed entry/byte bounds; malformed/duplicate/traversal/link/hash/extra/missing/oversize cases require executable negative tests. Manifest digest is pinned in root policy; JS checks projection binding before importing runtime. No general dependency verifier or unnecessary bundling project; symlinks must be materialized within the tree.

One layout issue is pending clarification: the verified local Chrome installation has framework/helper names with ASCII spaces (for example `Google Chrome Framework.framework` and `Google Chrome Helper (Aperitif Alerts).app`). The ruling's initial no-whitespace path grammar cannot represent those names. Renaming these is not assumed safe. Asked Lead to choose a bounded three-field-prefix parser with space-containing path suffix, or a distinct browser-tree rule; no runtime/compiler/native format change has been made for that pending choice.

## Native path grammar clarification — 2026-09-15

Lead77c07b6c-8f14-449a-8064-ba1ca3d1ffd8 selects one format for the entire fixed tree: exactly three single-space-delimited metadata fields, followed by path through end-of-line. Path may contain single ASCII spaces but no leading/trailing/doubled spaces, controls, non-ASCII, dot-dot components or absolute prefix. No escaping, no split browser rule, no renaming framework paths. Implemented projection and native parser follow that grammar and test spacing-only inventory substitution.

## Host aggregate contention instruction — 2026-09-15

Mailboxc0d866ed-a283-41ef-abab-b8190ecec458, `[lead-instruction host-contention 16:5xZ]`: stop owned host package/full-suite aggregate via its handle due host load127/18cores; do not start another. Exact-head CI is the aggregate of record; focused changed-file suites suffice locally. Package-gate13788 was interrupted through its existing handle and is **interrupted-under-host-contention / not relied on**; no complete receipt exists in its log. Patrol snapshot19952 had completed402/0 before the instruction. Both reports quote the instruction; future turns must not restart the host aggregate.
