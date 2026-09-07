# FLY-2365 六项目手册关联证据

这套证据只读抓取当前 `http://127.0.0.1:9876/api/fleet/snapshot`，先锁住六个项目与非本功能区段，再用当前分支 build 产物启动隔离 fixture。功能区段不手写 DTO：项目/角色卡由 `loadProjects` → `loadFeatureFlagProjectConfigs` → `buildTopologyView` 产生，DAG 由编译后的 menu seeds 经 `readManagementDags` 产生，最后由 `composeManagementSnapshot` 完成组合和 runtime contract 校验。

运行：

```bash
bash engineering/doc/FLY-2365-handbook-node-links/evidence/run.sh self-check
bash engineering/doc/FLY-2365-handbook-node-links/evidence/run.sh green
```

- `self-check` 会从 flywheel 的 `general` 角色卡故意移除唯一 ref；只有尺子以 `FLY2365_MISSING_UNIQUE_ROLE` 失败才算负控有效。连接失败、build 失败或别的异常都不能冒充成功负控。
- `green` 验证 flywheel 七个执行手册 ref 全部唯一命中，personal-assistant/general 精确命中 life 卡，另四个 legacy 项目逐节点明示无 roster/overlay，schema 2 缺 ref 仍渲染并显示“未关联”。它还检查节点类型与关联状态同时可见、两条说明各出现一次、chip 可见短文案不截断、浏览器零 console/page error、全程零非 GET 请求。
- 产物在 `green/metrics.json` 与七张 PNG。脚本从 `npm root -g` 自动定位 Playwright，也可用 `FLY2365_PLAYWRIGHT_ROOT` 覆盖；浏览器可执行文件由 Playwright 自己解析。短 `TMPDIR` 避免 Unix socket 路径过长。
