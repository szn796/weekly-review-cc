# Claude Agent SDK 能做什么

这份文档的目标不是“把官方文档翻译一遍”，而是帮你快速建立一个实用认知：

1. Claude Agent SDK 到底能做什么
2. 你现在这个周报项目用了其中哪些能力
3. 你以后想 DIY 一个新 agent，应该从哪里下手

适合阅读对象：

- 第一次接触 Claude Agent SDK
- 想把当前 demo 扩成别的 agent
- 想快速知道“有哪些能力值得用”

---

## 1. 一句话理解 Claude Agent SDK

你可以把 Claude Agent SDK 理解成：

**一个让你用代码启动 agent、限制工具权限、接收执行结果、继续扩展更多能力的开发框架。**

它不是单纯的“大模型聊天 SDK”。

它更像：

- 一个可以调用模型的程序入口
- 一个可以让模型安全使用工具的执行框架
- 一个可以做多轮任务、会话、权限、扩展的 agent 外壳

---

## 2. 最重要的心智模型

### 2.1 你不是在“调一个回答”

你是在“启动一个会做事的 agent”。

普通调用更像：

- 我问一句
- 模型答一句

Agent SDK 更像：

- 我给你任务
- 我告诉你能用哪些工具
- 你自己决定分析步骤
- 做完后把结果给我

### 2.2 你真正控制的是 4 件事

开发 agent 时，你通常控制这 4 个东西：

1. `Prompt`
   任务目标和规则
2. `Tools`
   agent 可以用什么工具
3. `Permissions`
   agent 的权限边界
4. `Output`
   最终结果长什么样

只要这 4 件事想明白，大多数 agent demo 都能做出来。

---

## 3. Claude Agent SDK 的能力地图

下面这张表是最重要的部分。

| 能力类别 | 它能做什么 | 你什么时候会用到 |
|---|---|---|
| 启动一次性任务 | 用 `query()` 启动一个 agent 去完成单次任务 | 你现在这个“周报 agent”就是这个模式 |
| 多轮会话 / 可恢复会话 | 保存会话、恢复会话、继续上次上下文 | 想做长期助手、反复追问的 agent |
| 工具调用 | 允许 agent 调用 Bash、Read、MCP 工具等 | 需要操作代码、文件、命令、外部系统 |
| 工具权限控制 | 限制哪些工具可用、哪些命令能跑 | 想做“可控、安全”的 agent |
| 自定义工具 | 自己定义工具，再交给 agent 调用 | 想把内部 API、数据库、业务逻辑封装给 agent |
| MCP 扩展 | 接各种外部系统和工具 | 想连 Jira、GitHub、数据库、飞书、浏览器 |
| Hooks | 在执行前后插入自己的逻辑 | 想审计、记录、拦截或增强行为 |
| 结构化输出 | 让最终输出符合 JSON Schema | 想把 agent 输出给别的程序继续消费 |
| 模型/权限/上下文控制 | 选择模型、控制 maxTurns、控制 permissionMode | 想平衡效果、成本、安全 |
| 运行状态与进度事件 | 接收执行中的消息、工具事件、最终结果 | 想做 CLI、UI、日志、监控 |
| 会话管理 | 查看历史 session、重命名、获取信息 | 想做“任务历史”“恢复执行” |
| 动态 MCP 管理 | 运行时连接、切换、重连 MCP server | 想做更灵活的扩展型 agent |

---

## 4. 你最应该先掌握的 8 个能力

如果你是小白，不要一下子全学。先掌握下面 8 个就够了。

### 4.1 `query()`: 启动一个 agent

这是最核心入口。

你给它：

- prompt
- options

它返回一个事件流，你边收事件边等最终结果。

你的当前项目就是这么做的。

### 4.2 `allowedTools` / `disallowedTools`: 限制工具

这是 agent 的安全边界。

比如你现在的项目只开放：

- `Bash(git:*)`
- `Read`

意思是：

- 只允许执行 `git` 相关命令
- 允许读文件
- 不允许乱执行别的 bash 命令

这是做 demo 时非常重要的“可信感”来源。

### 4.3 `permissionMode`: 权限模式

这是另一层安全控制。

常见理解：

- `default`
  标准权限模式
- `acceptEdits`
  自动接受编辑类操作
- `plan`
  只规划，不执行
- `dontAsk`
  不询问，未预批准的都拒绝

你现在这个项目用的是 `acceptEdits`，但实际开放的工具已经很窄，所以风险可控。

### 4.4 Prompt 设计

Prompt 决定 agent 的行为质量。

最常见的两个部分：

- `systemPrompt`
  规定角色、规则、输出格式
- `user prompt`
  给当前任务的具体输入

你现在这个项目用 prompt 把下面这些约束写得很清楚：

- 必须基于 git 证据
- 不能瞎编
- 输出固定标题
- 先看 `git log` 再看 `git show`

### 4.5 结构化输出 `outputFormat`

如果你不想让 agent 返回一大段自然语言，而是想让它返回 JSON，就可以用结构化输出。

适合场景：

- 风险清单
- 提交分类结果
- 测试用例列表
- 自动化流水线输入

比如以后你想把周报 agent 改成：

- 既输出 Markdown
- 又输出一份 JSON 摘要

这个能力就很有用。

### 4.6 `mcpServers`: 接外部系统

这是 Claude Agent SDK 很强的一块。

MCP 可以把很多外部能力接给 agent，例如：

- GitHub
- Jira
- 数据库
- 浏览器自动化
- 内部服务

你现在这个周报项目还没用 MCP，但以后很容易扩成：

- 读代码提交
- 再去 Jira 拉需求单
- 再去 GitHub 拉 PR
- 最后输出“需求-提交-风险”联动总结

### 4.7 自定义工具 `tool()` + `createSdkMcpServer()`

如果现成工具不够，你可以自己造一个工具给 agent 用。

比如你可以封装：

- `getApolloConfig`
- `queryWeeklyCommitStats`
- `fetchJiraIssue`
- `listChangedModules`

这样 agent 用的就不是原始 Bash，而是你定义好的业务工具。

这会带来两个好处：

1. 更安全
2. 更像“业务 agent”

### 4.8 Sessions: 会话与恢复

如果你想做的不只是“一次性任务”，而是一个可以持续用的 agent，就要了解 session。

常见能力：

- 列出历史 session
- 获取 session 信息
- 恢复 session
- 继续追问

适合场景：

- 长期代码助手
- 长链路排障助手
- 多次迭代的需求实现 agent

---

## 5. 进阶能力：你以后大概率会用到

### 5.1 Hooks

Hooks 可以理解成“在 agent 某些阶段插一段你的逻辑”。

你可以拿它做：

- 审计日志
- 操作记录
- 执行前检查
- 执行后补充上下文

比如：

- 每次 agent 想跑命令时都记录下来
- 每次 agent 改文件后都打审计日志

### 5.2 `canUseTool`

这是一种更精细的权限控制。

不是简单地说“这个工具能不能用”，而是你可以在运行时判断：

- 这个工具这次能不能用
- 这个输入参数能不能过
- 要不要拒绝

适合场景：

- 禁止改某些目录
- 禁止访问某些文件
- 禁止执行某些命令模式

### 5.3 `promptSuggestions`

这个能力能在一轮结束后，预测用户接下来可能会问什么。

适合：

- 做更智能的交互式助手
- 做 IDE 内提示
- 做下步推荐

### 5.4 `agentProgressSummaries`

这个能力会让运行中的子任务周期性产出进度摘要。

适合：

- 长任务显示进度
- UI 上展示“它现在正在做什么”

### 5.5 `onElicitation`

这个能力可以让 agent 在缺信息时向外部要数据，再继续。

你可以把它理解成：

- agent 执行到一半
- 发现还缺一个参数
- 触发“补信息”
- 拿到后继续跑

适合：

- 半自动流程
- 表单补充
- 登录授权

---

## 6. 当前这个周报项目用了哪些能力

你现在这个项目，实际上已经覆盖了 Agent SDK 的一条很标准的最小闭环：

| 能力 | 当前是否使用 | 说明 |
|---|---|---|
| `query()` | 已用 | 主入口就是一次性任务 agent |
| Prompt 设计 | 已用 | system prompt + user prompt |
| 工具权限控制 | 已用 | 只开放 `Bash(git:*)` 和 `Read` |
| 模型配置 | 已用 | 通过百炼兼容接口调用 `qwen3.5-plus` |
| 最终结果接收 | 已用 | 读取 `result` 事件 |
| 文件落盘 | 已用 | 报告写入 `reports/*.md` |
| MCP | 未用 | 还没接外部系统 |
| 自定义工具 | 未用 | 还没自己定义业务工具 |
| 结构化输出 | 未用 | 目前只输出 Markdown |
| Session 恢复 | 未用 | 当前是一次性运行 |
| Hooks | 未用 | 当前没有执行拦截和审计 |

这说明你现在这个项目很适合作为起点：

- 已经能讲清楚 Agent SDK 是什么
- 又没有复杂到讲不明白

---

## 7. 你基于当前项目，可以往哪些方向扩

下面是最值得做的扩展方向。

### 7.1 最容易扩：多仓库周报 Agent

把“固定一个仓库”改成：

- 支持输入多个仓库路径
- 分别分析
- 最后合并成一份团队周报

适合分享点：

- “从单仓库 agent 扩成团队周报 agent”

### 7.2 很实用：周报 + 风险 JSON 输出

保留 Markdown，同时增加结构化 JSON。

适合用途：

- 自动发机器人
- 自动写飞书卡片
- 自动接别的系统

### 7.3 更像业务 Agent：自定义业务工具

把原始 `git` 命令封装成工具，例如：

- `listWeeklyCommits`
- `getCommitFiles`
- `getCommitPatch`

好处：

- 更安全
- prompt 更简单
- 更容易复用

### 7.4 更强：接 MCP

扩成：

- 读 git 提交
- 读 Jira 需求
- 读 GitHub PR
- 输出“需求-代码-风险”联动分析

这会更像一个真正的工程效率 agent。

### 7.5 更像产品：会话型 Agent

做成：

- 第一步先生成周报
- 第二步用户追问“给我只看风险点”
- 第三步再追问“帮我变成汇报提纲”

这就从“一次性任务”变成“持续对话型 agent”了。

---

## 8. 如果你要 DIY，一个新 agent 应该怎么想

最稳的方式是按下面 6 个问题思考。

### 问题 1：任务目标是什么

例子：

- 读仓库本周提交并总结
- 读报错日志并给排查思路
- 读 PR 改动并给 review 风险点

### 问题 2：输入是什么

例子：

- 仓库路径
- 时间范围
- PR 链接
- 日志文件

### 问题 3：输出是什么

例子：

- Markdown
- JSON
- 风险列表
- 测试建议

### 问题 4：需要哪些工具

例子：

- Bash
- Read
- MCP
- 自定义工具

### 问题 5：权限边界是什么

例子：

- 只允许 `git`
- 不允许写文件
- 不允许联网
- 只允许访问某几个目录

### 问题 6：最小可演示版本是什么

不要一开始就做大。

先做：

- 单输入
- 单输出
- 单 agent
- 单场景

这条非常重要。

---

## 9. 一个很实用的 DIY 路线图

### 第 1 阶段：先做“一次性任务 agent”

你只需要掌握：

- `query()`
- prompt
- allowedTools
- 最终结果接收

这已经能做很多 demo。

### 第 2 阶段：再加“输出可机器消费”

开始学：

- `outputFormat`
- JSON 结构输出

### 第 3 阶段：再加“接外部系统”

开始学：

- `mcpServers`
- 自定义工具

### 第 4 阶段：再加“更强控制”

开始学：

- `canUseTool`
- hooks
- session

这时你就不只是会写 demo，而是真的会“搭 agent”了。

---

## 10. 你现在最值得记住的结论

如果只记 5 句话，记这 5 句：

1. Claude Agent SDK 不是普通聊天 SDK，而是 agent 执行框架。
2. 开发 agent 最核心的是：Prompt、Tools、Permissions、Output。
3. `query()` 是最常用入口，适合做单次任务 agent。
4. MCP 和自定义工具决定了 agent 能不能真正接业务系统。
5. 你当前这个“周报 agent”已经是一个标准、可讲清楚的最小闭环。

---

## 11. 对照官方文档时，你优先看什么

如果你后面要继续学，建议按这个顺序看官方资料：

1. Agent SDK Overview
2. TypeScript / SDK 基础用法
3. Permissions / Tools
4. MCP
5. Structured Output
6. Sessions
7. Hooks

官方资料：

- [Anthropic Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Anthropic MCP Docs](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Agent SDK on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## 12. 最后一句话

如果你现在问：

“Claude Agent SDK 都能做什么？”

最实用的回答是：

**它能让你用代码搭一个受控 agent，让模型在你设定的工具和权限范围里自己完成任务，并且还能继续接外部系统、加自定义工具、做会话、做结构化输出。**
