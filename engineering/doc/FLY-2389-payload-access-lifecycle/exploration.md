# FLY-2389 私有下载与保留期 — 探索
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: 无

## 目标与已有基础

凭授权码只下载允许的产品包；当前版本一直可用，历史 beta 在退任后保留 14 天、正式版保留 28 天。PRD 唯一产品来源：`product/doc/FLY-1098-release-cicd/prd.md` §2.1、§7.2、§7.3、§8、§9、§14 B2。本节点只交付设计，后续实现与 QA 由 DAG 推进。

B0 `packages/release-contract/CONTRACT.md` 已锁版本、双通道、不可变对象 key、CAS（比较目录版本后原子写入）和删除标记。B1 PR #1135 已合入，发布脚本、Worker 端点、license CLI、清理 CLI 都已存在。当前 `/payload/:ver` 通过 Worker 转发字节，尚未签发直连 R2 的短效链接；清理 CLI 只手动执行。不能另建一套 manifest、授权目录或支付系统。

## 决策比较

| 选择 | 结论 | 原因 |
|---|---|---|
| 私有 R2 + 原端点验 key + 302 到 60 秒 presigned GET | 采用 | URL 是短效下载凭证；R2 负责传输，安装器现有 fetch 跟随跳转并验 hash |
| 每次文件 GET 都由 Worker 代理 | 不作为目标模式 | 已有路径可用于本地/回退，但不能冒充本单 presigned GET 验收 |
| 公共 bucket / r2.dev / 公共自定义域名 | 拒绝 | 会绕过 entitlement（授权档位，即内部或客户可下载的集合） |
| R2 对 payloads 前缀按对象年龄删除 | 拒绝 | 上传时间不是退任时间；静置 current 会被误删，且 re-pin 无法与原生删除原子协调 |
| 搬迁 current/history + 双份对象或逐对象原生规则 | 拒绝 | B0 固定不可变 key；引入复制、恢复与规则对账，当前需求不需要 |
| 既有 retentionSince/quarantinedAt + CAS 删除标记 + 定时 sweep | 采用 | 保留产品 14/28 天语义与 re-pin 保护，只补自动运行和最小清理能力 |
| JWT license / Keygen / 新账号数据库 | 拒绝 | 现有随机 256-bit key + SHA-256 存储已支持签发、验证和吊销，无需自建签名协议 |

## Lead 已收口的边界

问题 `6fb0c951-9ca7-4bb4-ae8b-ff7734ea14fe` 已获 Engineering Lead 明确确认：

1. payload lifecycle 只有既有 manifest 时钟 + tombstone CAS 清理一个执行器，补上定时执行。canonical payload、manifest、key 前缀不设 R2 原生年龄删除；原生规则只清未完成 multipart（分段上传的残留片段）。无需另迁 historical 前缀。
2. presigned GET TTL 上限 60 秒。吊销/quarantine（隔离坏版，即禁止新下载授权）停止签新链接；已签链接最多在剩余 60 秒内仍可开始下载。这是明确接受的限制，不宣称逐请求即时撤销，已经开始/完成的下载也不能召回。

Lead onboarding 指令 `c26d76c6-75ad-4e5b-8091-01fcd0f44377` 已 ACK：明确 secret 注入路径；B1+B2 联合 E2E 后才激活。设计不得访问或回显任何真实 key。

## 审计发现与设计必须覆盖的失败

- 上传收尾的 `hasLiveClaim` 只看 reserved/prepared：若 PUT 返回前另一请求已 commit，收尾会误删 current。研究用内存夹具复现，纳入最小修复。
- `/admin/key/:sha` 当前可覆盖已有 key 并写回 revoked=false；改为条件创建与无写入幂等重试，吊销单向。
- ops-admin 还能签 key，不能为定时清理把它放入普通计划任务。新增 cleanup 能力只允许读 manifest、expire、tombstone、guarded DELETE。
- 原生 presign 不会替我们查对象是否存在或校验用户权限；必须先验证 key、完整 manifest、可见集、对象元数据，再签确切 GET。
- 清理调度故障可能延迟物理删除：到期读路径先拒绝新下载，清理错误可重试且显式失败，不能报告已删除。

## 范围

本设计覆盖 Worker/R2 配置、授权码薄生命周期、下载跳转、保留期自动化、必要消费者测试和 B1 联合 E2E。REQ-0 保持 ship 与 release 独立，不新增发布触发、不复用 ship approval。B4 的默认发版、B5 自动更新器、计费/账号/席位/计量不在本单。实现、部署、真实 bucket/key 操作与 QA 都尚未发生。
