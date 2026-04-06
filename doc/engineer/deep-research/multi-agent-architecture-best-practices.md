# Flywheel 多代理系统架构最佳实践

> Source: ChatGPT Deep Research, 2026-03-30
> Relevant to: FLY-26 (rules scalability), FLY-11 (terminal MCP), FLY-20 (CD automation)

## 核心原则

在构建多代理团队时，**避免单体式(agentic monolith)**是关键：一个代理承担过多职责会造成混乱、高错误率。可靠性来源于模块化与专门化，多代理系统相当于 AI 的微服务架构。最佳做法是**明确分工**，让不同代理负责不同任务，并通过确定的通信协议协作。常见模式包括流水线模式（Sequential Pipeline）、协调者/派发者模式（Coordinator/Dispatcher）和层级式模式。

现代多代理框架强调**工具调用与有状态执行**，而非冗长的"对话式提示"。多代理架构应更多依赖**外部系统和工具**来执行业务逻辑，把模型主要角色定位为决策和协调者，而把具体操作封装在工具/APIs 中，实现**可观测、可恢复和可测试**的执行过程。

## 不同框架的角色定义方式

- **CrewAI**: 使用静态配置文件（推荐 YAML）定义代理。`config/agents.yaml` 中定义 role/goal/backstory，代码中加载。可复用且集中管理。
- **AutoGen (AgentChat)**: 通过编程定义代理行为，继承 `BaseChatAgent` 实现 `on_messages()`。灵活但需管理类和方法。
- **LangGraph**: 低级别编排框架，不直接定义代理角色。用图和代码搭建多步流水线，强调可恢复执行、观察性和人机协作。
- **AgentsMesh**: Pod/通道方式，每个代理运行在独立 Pod 中。配置代理类型、模型、权限和初始提示。产品层面的托管平台。
- **OpenAI Swarm**: 轻量级，代理由名字、指令和可调用函数构成。无持久化状态，完全在客户端迭代。
- **Claude Agent SDK**: 文件系统式配置。代理定义为单个 Markdown 文件，YAML frontmatter + 系统提示正文。支持 name/description/tools/model/permissionMode。

## 静态大提示外的替代架构

- **动态规则注入**: 通过 API 或事件在运行时更新代理规则。Claude Code 中新建/修改子代理文件后用 `/agents` 即可即时加载。
- **共享行为模块**: Claude Code 支持 `.claude/skills/` 目录下编写公用 SKILL.md，在代理 frontmatter 中引用。
- **事件驱动设计**: 用图状态机处理分支和并行流程，将任务切分为工作流节点。
- **自我进化代理**: 用长期记忆（RAG）记录经验，通过人类监督定期审查并更新配置。

## "提示驱动" vs "工具驱动" 的权衡

全部行为写在提示里：直观简单，但大提示占用上下文，引起"遗忘"，且规则不易测试或重用。
将逻辑封装在工具/API 中：更可靠易维护。"使用原生工具调用要比纯文本提示更可靠、自我纠错"；"工具设计才是架构的核心。每个工具应封装一个原子操作，具备良好错误信息和输入校验"。

## 对 Flywheel 的具体建议

1. **模块化规则管理**: 把共享行为准则抽到公共模块或技能。用 `.claude/skills/` 写技能文件，各 Lead frontmatter 引用。或 Bridge 维护规则数据库，启动时动态加载。
2. **事件驱动和协调者**: Simba 作为协调者代理，只负责接收任务并分配给其他 Leads。Bridge 发布任务事件让对应 Lead 触发。
3. **精简主提示，强化工具**: 减少每个 Lead 系统提示大小，将行为逻辑拆分到工具/API 和 Bridge 事件。
4. **利用 Claude Code 子代理特性**: 为不同职能创建专门子代理文件，使用技能和 frontmatter 共享通用内容。
5. **引入监控与可观测**: 记录每步操作日志和工具调用结果，使用 Bridge 状态存储跟踪进度。
