# Exploration: sql.js / StateStore WASM 损坏的真根因 — FLY-663

**Issue**: FLY-663 (sql.js / StateStore WASM 损坏的【真根因】—— 为啥会损坏，不只 639 抗崩)
**Date**: 2026-06-29
**Status**: Complete

---

## 1. Problem

FLY-639（PR #379）修了【抗崩】：sql.js WASM 损坏时 Bridge 自愈不崩、不再每小时 crash-loop。但它是 **band-aid**——没回答**为啥 sql.js WASM 会损坏**。

**Annie 的关键洞察（2026-06-29 crash incident）**：48GB 机器内存健康（Cass 查：53% free、swap 0）情况下，那个 in-memory WASM DB 还是损坏（`no such table: sessions`）。Annie：『如果 48GB 也会因内存压力崩，一定是我们自己哪里写的有问题。』

→ 真根因**大概率是代码层 bug（我们怎么用 sql.js）**，不是外部系统内存压力。本 issue = root-fix，让它**压根不损坏**。

---

## 2. Root Cause（已用复现实测验证）

### 2.1 核心：`save()` 在【每一次写】都全库 `db.export()`

`packages/teamlead/src/StateStore.ts` 的持久化模型是：

```ts
private save(): void {
  if (this.dbPath === ":memory:") return;
  const data = this.db.export();              // ← 每次写都调
  writeFileSync(this.dbPath, Buffer.from(data));
}
```

`save()` 在 **34 处** 写操作后被调用（`insertEvent` / `upsertSession` / `persistTransition` / `updateHeartbeat` / 各 CRUD …）。即**每一次 mutation 都会 `db.export()` 一次**。

反编译 sql.js 1.14.1 dist，`export()`（minified `Nb`）的真实行为是：

```js
prototype.Nb = function(){
  Object.values(this.gb).forEach(l => l.Ya());   // 释放所有已登记 statement
  Object.values(this.Sa).forEach(A); this.Sa={}; // 释放注册函数
  this.handleError(w(this.db));                  // sqlite3_close(db)  ← 关连接
  var f = ta(this.filename);                     // 从 MEMFS 读出整库字节
  this.handleError(q(this.filename, g));         // sqlite3_open       ← 重开连接
  this.db = r(g,"i32"); ob(this.db); return f;   // 新 db 指针 + 重注册函数
};
```

即 `export()` 会 **close + reopen SQLite 连接 + 把整库重新序列化成一个全新的连续 buffer**。这是个**重量级、破坏性**操作，却被放在了每一次写的热路径上。

### 2.2 叠加因素：三个一起才致命

| 因素 | 现状 | 后果 |
|---|---|---|
| **A. export-on-every-write** | 每次写全库 close+reopen+序列化 | 每写一次就在 WASM 堆里分配一份整库大小的连续 buffer |
| **B. 无界增长** | `session_events` / `lead_events` **从不 prune**（见下「历史 archaeology」；生产库实测 lead_events 14077 行、session_events 6713 行、sessions 仅 502、库 22MB——大头就是这俩 event 表 ~21K 行） | export 的 buffer 越来越大 |

**历史 archaeology（Annie 关键线索 + git log/blame 实证）**：Annie 记得「以前出过更严重的崩、当时库太大、做过定时清理老内容、但不确定做好没」。查证：
- `session_events` / `lead_events` **从开天辟地零 prune**（全 git 历史无 `DELETE FROM session_events` / `lead_events`）。
- Annie 记的「历史清理」= forum `conversation_threads` 的 **CleanupService**（`getEligibleForCleanup` / `markArchived` 等），在 **FLY-163（PR #193）连 forum 概念一起整个移除**。它清的是 forum **线程**、从不覆盖 event 日志表 → 这就是「清理没真做好」的真相：当年清理是 forum-only，event 表一直漏。
- `sessions` 也无 prune（Cass 看到 502 像「有清」是误判）——它只是天然每 run 1 行、增长慢；event 表每 run 多行、才是 22MB 的大头。
| **C. WASM 线性堆有上限且易碎片化** | sql.js 1.14.1 dist 实测 `MAXIMUM_MEMORY = 2147483648`（2GB），地址空间 4GB；这块堆**与系统 RAM 完全独立** | 大块连续分配在碎片化的 2GB 堆里会失败 |

**机制**：十几个 runner 高频写 → 每秒几百次全库 export → 每次都在 2GB 的 WASM 线性堆里申请/释放一份「整库大小」的连续内存。emscripten 的 allocator（dlmalloc/emmalloc）在这种「大块、高频、变大」的 churn 下**碎片化**。当某次 export 需要的连续块在碎片化的堆里找不到 → `malloc` 返回 0 → SQLite 拿到空指针 → 往 null/越界写 → WASM 间接调用表被写坏 → 后续任何调用报 **`null function or function signature mismatch`**，查询报 **`no such table: sessions`**（正是生产签名 + FLY-639 commit 记录的签名链）。

**为什么 48GB free 无关**：耗尽/碎片化发生在**进程内的 2GB WASM 线性堆**里，跟系统那 48GB RAM 是两回事。这精确解释了 Annie 的观察。

### 2.3 排除的其它假设（避免误导方向）

审计后**排除**了以下：

- **JS 层并发数据竞争 / 缺锁**：StateStore 所有方法都是**同步**的（唯一 `async` 是 `create()` 里的 `initSqlJs()`）。Node 单线程 + 同步方法 = 单个方法调用对 sql.js 而言原子、不会被打断。多个 poller / HTTP handler 是独立 event-loop turn，**不会**在某个同步方法中途插入。所以没有 JS 层数据竞争。
- **statement 跨 save 的 use-after-free**：所有 read 方法都是 `prepare → step → free`，`free()` 一律在 `save()` 之前；`db.run(sql, params)` 内部 `finally{ stmt.free() }`。没有 statement 活过一次 export。
- **statement 泄漏累积**：即使某 read 在 `free()` 前抛错漏掉一次 free，下一次 `export()` 的 `forEach(l => l.Ya())` 会把它清掉——所以不是无界 statement 泄漏。

→ 唯一能写坏 WASM 间接表的路径就是 **2.2 的内存机制**（破坏性 export + 无界增长 + 有限易碎堆）。

---

## 3. 复现实测（evidence）

写了两个同 workload 的 harness（十几个 exec id 高频 insert event + upsert session + 读 active sessions，payload 带 2KB blob 模拟真实负载）：

| | sql.js（export-on-every-write，**复刻 StateStore**） | better-sqlite3（增量 WAL 写） |
|---|---|---|
| 跑到的库大小 | 22.7 MB | **206 MB** |
| 进程 RSS | **1.4–1.6 GB**（持续上爬，向 2GB WASM 上限逼近） | 614 MB（平稳、与库成比例） |
| `external`(WASM/buffer) | 100–200MB 剧烈抖动 | 平稳 |
| 迭代数 / 用时 | ~5,500 次（慢） | **50,000 次 / 15.8 秒**（快 4–5 倍） |
| 损坏 | 机制成立（堆爬向 2GB 上限） | 无 |

**结论**：仅 20MB 的库，sql.js 的 export-on-write 模型就把 RSS 顶到 ~1.5GB 并持续上爬；better-sqlite3 在同 workload 下内存平稳、9 倍大的库只用一半 RSS、且快 4–5 倍。生产里库会随无界事件表继续涨 + 十几个 runner 同时写——必然把 2GB WASM 堆撞穿/碎片化 → 损坏。

> harness：`scratchpad/repro.mjs`（sql.js）+ `scratchpad/repro-bsq.cjs`（better-sqlite3）。

---

## 4. 候选方案

### 方案 A（推荐）— 迁 StateStore 到 better-sqlite3（root-fix）

- **原生 SQLite**：没有 WASM 线性堆 → **没有可耗尽/可碎片化/可写坏间接表的东西**。损坏在结构上不可能（系统 RAM 才是唯一限制，SQLite 处理 GB 级库毫无压力）。
- **增量 WAL 写**：删掉 `export()`-on-every-write；每次 `run()` 直接落 WAL，**不再全库重写**。内存平稳。
- **同步 API**：与 StateStore 现有（已全同步）方法一一对应，**公开方法签名不变 → 调用方零改动**。
- **已是仓内验证过的依赖**：`packages/teamlead` 的直接依赖 `better-sqlite3@^12.8.0`（在 root `onlyBuiltDependencies`，FLY-153 已根治构建问题），`SqliteJournalStore` + `fleet-admin-audit` 已在用。
- **现有库平滑过渡 = 非问题**：sql.js `export()` 写的本来就是**标准 SQLite3 文件格式**。实测 better-sqlite3 **直接打开生产 23.4MB `~/.flywheel/teamlead.db`**：11 张表、`user_version=2`、502 sessions / 6715 events / 14090 lead_events 全在。**零数据转换**，原地打开即可。

### 方案 B（更轻、但只缓解不根治）

留 sql.js，改：(1) debounce/批量 save（不再每写 export，定期 flush）；(2) prune 无界表；(3) 原子 temp+rename 写。
- 降低 churn，但仍跑在脆弱的 WASM 模型上、export 仍破坏性 → **不能彻底消除损坏**，且 debounce 会放大 FLY-639 已知的「未 flush 数据丢失」窗口。不满足『压根不损坏』。

---

## 5. Decision

**Lead + Cass + Annie 拍板：方案 A，且本 plan 必须包【两半】**（2026-06-29）：
1. **治崩** = 迁 better-sqlite3（原生 SQLite 没 WASM 堆 → 损坏结构上不可能；增量 WAL 不再每写全库 export；API 1:1 调用方零改；库内已验证；保留 FLY-639 `recoverFromCorruption` 休眠保险）。
2. **治胖** = 给 `lead_events` / `session_events` 加 **retention/prune**（留最近 N 天、更老的删、库不失控）。Annie：「这里面都是对话、没必要一直存」。光换引擎只治崩、库还会一直涨——两半缺一不可。

范围限 `StateStore.ts` + 一个现有 poller 接线 + 测试 + WAL 副车运维文档，TDD。retention 设计见 plan §2.6（安全 allowlist：只删 terminal+老 / 已投递+老，不碰活跃 session 与未投递事件）。

附带收益：去掉「kill 进程时 `writeFileSync` 写到一半 → 截断文件」的隐患（WAL + 原子 commit）；快 4–5 倍；内存平稳。

---

## 6. 与 FLY-639 的关系

- FLY-639 = band-aid（抗崩 + 自愈）。本 issue = root-fix（防损坏）。**两个都要**（Annie 明确）。
- 迁 better-sqlite3 后，sql.js 式损坏不再可能，`recoverFromCorruption` / `isSqlJsCorruptionError` / `onUnrecoverableCorruption` 成为**休眠保险**：保留方法（3 个 poller 用 `typeof === "function"` 守卫调用，安全），不删，作为纵深防御。
- Cass 另外盯系统内存压力本身（突发尖峰）——与本 issue 正交。

---

## 7. Downstream

→ Research（本文档已含审计）→ Plan（`doc/engineer/plan/draft/`）→ Codex design review → Apple-light HTML present 给 Annie → implement（TDD）→ 独立 QA（529 Room、restart-gated）→ founder ship-gate。
