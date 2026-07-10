# transcript: e3-ips-classification (plan Step 4)
# producer: FLY-1117 implement 阶段的独立分析子 agent(general-purpose,只读),2026-07-10 ~01:45 PDT
# inputs: evidence/ips/ 全部 27 件(24 .ips + 3 .diag);逐份 JSON 解析(python3)
# note: 本文件为子 agent 最终报告逐字保存;分桶判定规则 = plan.md Step 4 合同

---

# FLY-1117 E3 — 2026-07-09 崩溃报告分类(27 份保全证据)

**输入**: `evidence/ips/` — 24 份 user 域 `.ips` + 3 份 system 域 `.diag`。
**计数更正**: 实际为 **OrcaSlicer×18**(issue/exploration 写 17;逐一枚举 24 份 .ips = OrcaSlicer 18 + BambuStudio 1 + Google Chrome 1 + biome 1 + chrome-headless-shell 2 + node 1)。
**通用事实**: 所有 24 份 .ips 的 `memoryStatus` 均为空、无 jetsam/EXC_RESOURCE 字样;OrcaSlicer/BambuStudio/Chrome 均为 x86-64 Rosetta translated,其余为原生 arm64。全部崩溃进程的 coalition 为 `com.flywheel.bridge` 或 `com.flywheel.lead.flywheel-flywheel-cos-lead`(即 Flywheel 自动化派生进程)。

## ① 分类总表

| 文件(简写) | 时刻 (-0700) | app / arch | exception / termination | faulting 签名短形 | 桶 |
|---|---|---|---|---|---|
| BambuStudio-002600 | 00:26:00 | BambuStudio 02.07.01.62 (x86-64/Rosetta) | EXC_BAD_ACCESS / SIGSEGV @0x0 | `GUI::get_min_flush_volumes` ← `CLI::run` | 应用自身 bug |
| OrcaSlicer-113239 | 11:32:39 | OrcaSlicer 2.4.2(装载自 `/private/tmp/*`) | EXC_CRASH / SIGABRT (`abort() called`) | `demangling_terminate_handler` ← `__cxa_rethrow` ← `boost::log::core::push_record_move` ← `CLI::run` (未捕获 C++ 异常) | 应用自身 bug(单例) |
| OrcaSlicer-204217 | 20:42:17 | OrcaSlicer 2.4.2 | EXC_BAD_ACCESS / SIGSEGV @0x8 | SIG-A: `std::string::operator=` ← `CLI::run+27934` | 应用自身 bug |
| OrcaSlicer-204318 | 20:43:18 | 同上 | 同上 @0x8 | SIG-A | 应用自身 bug |
| OrcaSlicer-211114 | 21:11:14 | 同上 | 同上 @0x8 | SIG-A | 应用自身 bug |
| OrcaSlicer-211229 | 21:12:29 | 同上 | 同上 @0x8 | SIG-A | 应用自身 bug |
| OrcaSlicer-211305 | 21:13:05 | 同上 | 同上 @0x8 | SIG-A | 应用自身 bug |
| OrcaSlicer-211308 | 21:13:08 | 同上 | 同上 @0x8 | SIG-A | 应用自身 bug |
| Google Chrome-211740 | 21:17:40 | Chrome 150.0.7871.114 (x86-64/Rosetta) | EXC_CRASH / SIGABRT (`abort() called`) | `abort` ← HIServices `_RegisterApplication` ← `TransformProcessType` ← `ChromeMain` | 未归桶:环境/启动失败(单例) |
| chrome-headless-shell-211828 | 21:18:28 | headless-shell (arm64) | EXC_BREAKPOINT / SIGTRAP | Chromium CHECK-crash,thread 12 `ThreadPoolSingleThreadForegroundBlocking0`,font/序列化区段(nearest-symbol `fontations_ffi…`) | 应用自身 bug |
| chrome-headless-shell-211828.000 | 21:18:28 | 同上(孪生进程) | 同上 | 同一签名 | 应用自身 bug |
| OrcaSlicer-220802 | 22:08:02 | OrcaSlicer 2.4.2 | EXC_BAD_ACCESS / SIGSEGV @0x4 | SIG-C: `get_extruders_order` ← `reorder_filaments_for_minimum_flush_volume` ← `FilamentGroup::calc_*` | 应用自身 bug |
| OrcaSlicer-221241 | 22:12:41 | 同上 | 同上 @0x8 | SIG-B: `calc_filament_change_info_by_toolorder+468` ← `ToolOrdering::reorder_extruders_for_minimum_flush_volume` ← `_make_wipe_tower` | 应用自身 bug |
| OrcaSlicer-221549 | 22:15:49 | 同上 | @0x8 | SIG-B | 应用自身 bug |
| OrcaSlicer-222034 | 22:20:34 | 同上 | @0x8 | SIG-B(`Print::process+8156` 变体) | 应用自身 bug |
| OrcaSlicer-222150 | 22:21:50 | 同上 | @0x8 | SIG-B | 应用自身 bug |
| OrcaSlicer-222257 | 22:22:57 | 同上 | @0x8 | SIG-B | 应用自身 bug |
| OrcaSlicer-222543 | 22:25:43 | 同上 | @0x4 | SIG-C(`+2302` 变体) | 应用自身 bug |
| OrcaSlicer-222622 | 22:26:22 | 同上 | @0x8 | SIG-B | 应用自身 bug |
| OrcaSlicer-222819 | 22:28:19 | 同上 | @0x8 | SIG-B | 应用自身 bug |
| OrcaSlicer-222901 | 22:29:01 | 同上 | @0x0 | SIG-B(`+332` 偏移变体) | 应用自身 bug |
| OrcaSlicer-223010 | 22:30:10 | 同上 | @0x0 | SIG-B(`+332`) | 应用自身 bug |
| biome-172924 | 17:29:24 | biome (arm64,parent=node) | EXC_CRASH / SIGABRT (`abort() called`) | `abort` ← biome 自身无符号帧(Rust panic→abort 形态,无 panic 消息留存) | 未归桶:单例存疑 |
| node-194358 | 19:43:58 | node (arm64, homebrew) | EXC_CRASH / SIGABRT (`abort() called`) | `node::OOMErrorHandler` ← `v8::internal::V8::FatalProcessOutOfMemory` ← `Heap::CheckIneffectiveMarkCompact` ← GC 分配慢路径 | **资源压力(实证)** |
| node_151442.diag | 窗口 06:06→15:14 | node pid 35918 | 非崩溃:disk-writes 资源通告(Action taken: none) | libuv worker `write()`,2147 MB / 32861 s | 资源压力共现(非失败) |
| node_155715.diag | 窗口 15:14→15:57 | node pid 57613 | 同上 | libuv worker `write()`,8590 MB / 2556 s;footprint 90→1332 MB | 资源压力共现(非失败) |
| GoogleChromeHelper_022154.diag | 窗口 07-08 19:38→07-09 02:21 | Chrome Helper pid 4467 | 同上 | ChromeMain 内 `pwrite/open`,2147 MB / 24223 s | 资源压力共现(非失败) |

## ② 签名聚类(OrcaSlicer 18 份)

| 组 | faulting 签名 | 份数 | fault 地址 | 时段 |
|---|---|---|---|---|
| SIG-A | `libc++ std::string::operator=` ← `Slic3r::CLI::run+27934` | **6** | 全部 0x8(近空) | 20:42–21:13 |
| SIG-B | `Slic3r::calc_filament_change_info_by_toolorder`(+468×7 / +332×2)← `ToolOrdering::reorder_extruders_for_minimum_flush_volume` ← `Print::_make_wipe_tower` / `Print::process` | **9** | 0x8×7、0x0×2(全部近空) | 22:12–22:30 |
| SIG-C | `Slic3r::get_extruders_order`(+2086 / +2302)← `reorder_filaments_for_minimum_flush_volume` ← `FilamentGroup::calc_min_flush_group*` | **2** | 全部 0x4(近空) | 22:08 / 22:25 |
| SIG-D | SIGABRT:未捕获 C++ 异常经 `boost::log push_record_move` rethrow(CLI 启动早期) | **1** | n/a | 11:32(bundle 在 `/private/tmp`,与其余 17 份的 `/Applications` 安装不同) |

三个 SEGV 签名组(17 份)全部落在同一功能族——**filament flush-volume / tool-ordering 计算**(SIG-A 的 `CLI::run+27934` 偏移 6 份逐字节一致),faulting 地址全部为 0x0/0x4/0x8 近空指针,vmRegionInfo 均确认 "not in any region"。BambuStudio 唯一一份也是同源代码库同族函数 `get_min_flush_volumes` 的 0x0 空指针解引用。全部在 `Slic3r::CLI::run` 主线程内 = headless CLI 切片调用形态。

## ③ 可疑注入 image 检查

**无。** 24 份 .ips 逐份扫描 `usedImages`:除 `/System`、`/usr/lib`、app bundle 自身外,仅 node-194358 出现 `/opt/homebrew/*` 下 21 个 dylib(libnode/libuv/libicu/libssl 等)——全部是 Homebrew node 发行版自带依赖,属进程正常装载集,不构成注入旁证。无未知路径、无第三方注入框架、无非常规 provenance image。

## ④ 资源压力实证检查

- **有实证(1 份)**: `node-2026-07-09-194358.ips` — faulting 栈为 `v8::internal::Heap::FatalProcessOutOfMemory` → `ReportOOMFailure` → `node::OOMErrorHandler` → `abort`,底部是 GC 分配慢路径,为明确的 V8 JS 堆分配失败。
- **无实证(其余 23 份 .ips)**: 全部无 allocation failure / EXC_RESOURCE / jetsam 字样,`memoryStatus` 为空;按判定规则不得计入资源压力桶。
- **3 份 .diag** 均为 **disk-writes 资源通告(非崩溃、Action taken: none)**,证明当天存在持续大量磁盘写入(node 两段共 ~10.7 GB;Chrome Helper 2.1 GB),属资源压力**共现描述**,不是任何一次崩溃的失败实证。

## ⑤ 每桶代表性文件

- **应用自身 bug(20 份)**: SIG-A 代表 `OrcaSlicer-2026-07-09-204217.ips`;SIG-B 代表 `OrcaSlicer-2026-07-09-221241.ips`;SIG-C 代表 `OrcaSlicer-2026-07-09-220802.ips`;同族 `BambuStudio-2026-07-09-002600.ips`;SIG-D `OrcaSlicer-2026-07-09-113239.ips`;CHECK-crash 代表 `chrome-headless-shell-2026-07-09-211828.ips`(与 `.000` 同签名孪生)。
- **资源压力(1 份实证 + 3 份共现)**: 实证 `node-2026-07-09-194358.ips`;共现 `node_2026-07-09-155715_MacBook-Pro.diag`(最重,8.6 GB/2556 s)。
- **注入/攻击旁证(0 份)**: 无。
- **未归桶(2 份,单例、证据不足)**: `Google Chrome-2026-07-09-211740.ips`(GUI 注册 WindowServer 失败形态的 abort,parent 已退出、coalition 为 cos-lead,提示从 agent 会话环境启动 GUI Chrome 失败;非注入、非资源实证);`biome-2026-07-09-172924.ips`(Rust abort,无符号、无 panic 消息)。

## ⑥ E3 结论草稿

> **E3 — 27 份 2026-07-09 崩溃/资源报告分类结论(置信度:高,基于全量逐份解析)**
> 24 份用户域崩溃中 20 份(83%)判为「应用自身 bug」:OrcaSlicer 17 份 EXC_BAD_ACCESS 聚成 3 个高重复签名(6/9/2 份),faulting 地址全部为 0x0/0x4/0x8 近空指针,且全部落在同一 filament flush-volume / tool-ordering 代码族的 `Slic3r::CLI::run` headless 调用内;BambuStudio 唯一一份为同源代码库同族函数的 0x0 空指针解引用;chrome-headless-shell 两份为同签名 Chromium CHECK-crash 孪生。资源压力桶仅 1 份有实证——node 19:43 崩溃的 faulting 栈明确为 V8 `FatalProcessOutOfMemory`(JS 堆分配失败);其余 23 份均无 allocation failure / EXC_RESOURCE / jetsam 字样,3 份 .diag 磁盘写入通告仅作当日 I/O 高压的共现描述,不作为任何崩溃的因果证据。注入/攻击旁证为零:全部 24 份的装载 image 逐份核查,无未知或异常 provenance image。Chrome GUI abort 与 biome abort 各 1 份为单例、证据不足,不归桶。晚间 20:42–22:30 的 OrcaSlicer 密集簇与 21:17–21:18 的 Chrome/headless-shell 崩溃在时间上共现,且全部崩溃进程隶属 Flywheel bridge/cos-lead coalition(即自动化派生的 CLI/headless 任务),此处仅记录共现,不下因果结论。

**补充观察**(仅数据,不改变分桶):① OrcaSlicer-113239 的 bundle 路径在 `/private/tmp/*`,与晚间 17 份的 `/Applications` 安装不同,是当日唯一的非标准安装位运行;② 所有 OrcaSlicer/BambuStudio/Chrome 崩溃进程均为 Rosetta 转译 (x86-64),node/biome/headless-shell 为原生 arm64。
