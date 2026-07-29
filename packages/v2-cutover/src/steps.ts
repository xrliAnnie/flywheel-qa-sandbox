export const CUTOVER_STEPS = [
	{ step: 1, title: "预演" },
	{ step: 2, title: "冻结" },
	{ step: 3, title: "停全部旧写者" },
	{ step: 4, title: "一致快照" },
	{ step: 5, title: "迁移" },
	{ step: 6, title: "安全重置" },
	{ step: 7, title: "epoch fence" },
	{ step: 8, title: "顺序启动" },
	{ step: 9, title: "回滚点" },
] as const;
