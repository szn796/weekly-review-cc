# Claude Agent 周报 Demo — 快速参考

一句话描述：对本地 Git 仓库说一句自然语言，AI 自动分析提交并输出中文 Markdown 周报。

---

## 适用场景

| 场景 | 说明 |
|---|---|
| **个人周报** | 每周五说一句"帮我看下这周提交"，直接拿到结构化周报 |
| **项目负责人** | 快速了解团队成员本周提交分布、风险模块、验证建议 |
| **Code Review 前摸底** | 进入评审前先看 AI 归纳的关键主题和影响范围 |
| **跨项目巡检** | 切换不同仓库参数，批量生成多项目周报复盘 |

---

## 功能与输入方式

### 1. 自然语言一句话（最轻量）
```bash
npm run report
# > 帮我看下 weass b 上周提交
```
AI 自动解析仓库名 + 时间范围，无需记参数。

### 2. 混合模式（灵活组合）
```bash
npm run report -- --repo=weass-b
# > 上周
```
仓库显式锁定，时间交给 AI 理解。适合"仓库确定、时间模糊"的场景。

### 3. 全显式参数（最稳定）
```bash
npm run report -- --repo=weass-b --since=2026-04-01 --until=2026-04-07
```
零交互、可控可复现，适合 CI 或定时任务。

### 4. 模糊匹配 + 交互选择
```bash
npm run report -- --repo=weass
```
当关键词匹配到多个仓库时，终端列出候选，输入序号即可选择。

### 5. 智能追问（信息不足时）
```bash
npm run report
# > 帮我看下 weass 提交
# AI: "你想看哪个 weass 项目？"
# > weass-b-mono
```
AI 不瞎猜，不确定时主动澄清，确认后继续执行。

---

## 输出结构

生成的报告固定包含以下章节：

1. **本周概述** — 提交数量、作者、主要方向
2. **关键主题** — 3~5 条短 bullet，归纳工作脉络
3. **主要提交** — 重要提交的 SHA、标题、影响和分析
4. **影响模块** — 按 packages/ 路径前缀归类改动类型
5. **风险与关注点** — 基于证据的风险提示（如 controller / 全局配置改动）
6. **建议验证点** — 3~5 条可执行的验证建议

输出同时打印到终端，并落盘到 `reports/weekly-summary-<项目名>-<开始日期>-to-<结束日期>.md`。

---

## Agent 做了什么，怎么做的

### 做了什么

这个项目的核心不是"手写 git 统计规则再拼接 Markdown"，而是让 **AI agent 自己调用工具、读取证据、组织结论**。

具体分工：

| 谁 | 职责 |
|---|---|
| **宿主程序**（TypeScript CLI） | 解析参数、准备环境、校验仓库、限定工具权限、收拢输出 |
| **resolver agent** | 把一句模糊的自然语言（如"帮我看下 weass b 上周提交"）解析成精确的仓库路径 + 时间范围 |
| **report agent** | 在目标仓库内执行 git 命令、读取提交详情、分析影响范围、生成中文 Markdown 周报 |

最终产物是一份固定包含 6 个章节的结构化周报：概述、关键主题、主要提交、影响模块、风险与关注点、建议验证点。

### 怎么做的

#### 1. 两阶段 Agent 架构

```
用户输入自然语言
    │
    ▼
┌─────────────────┐     ┌─────────────────┐
│  resolver agent │ ──▶ │  report agent   │
│  （理解需求）     │     │  （分析仓库）     │
└─────────────────┘     └─────────────────┘
        │                        │
        ▼                        ▼
   解析出 repoPath           执行 git log
   解析出 since/until        执行 git show
   必要时追问用户             读取 patch 细节
                             生成 Markdown
```

- **resolver agent** 只在"仓库或时间信息不完整"时启动。它通过 `ls`、`find`、`git` 等工具在搜索目录里定位仓库，同时根据当前时间理解"上周"、"最近三天"等相对表达。如果信息不足，它会主动追问（最多 2 轮），而不是瞎猜。
- **report agent** 在 resolver 产出精确上下文后才启动。它的工作目录被固定到目标仓库，只被允许使用 `Bash(git:*)` 和 `Read` 两类工具。

#### 2. 工具权限控制（安全边界）

report agent 的工具面被故意缩到最小：

```ts
allowedTools: ["Bash(git:*)", "Read"]
```

这意味着 agent 可以执行 `git log`、`git show`、`git diff` 等命令，也可以读取仓库内的文件，但**不能**执行 `rm`、`curl`、`npm install` 等其他 shell 命令。这是 demo 的核心安全边界。

resolver agent 的工具面稍宽，增加了 `ls`、`find`、`cat`，以便在搜索目录里定位仓库，但同样不能执行任意命令。

#### 3. Prompt 工程

Prompt 分两层：

- **System Prompt**（长期规则）：定义 agent 的身份、行为边界、输出格式。例如"只能基于 git 证据下结论，不允许编造"、"输出必须是中文 Markdown"、"必须先 `git log` 再 `git show`，只对重点提交看 patch"。
- **User Prompt**（本次任务）：传递具体参数——分析哪个仓库、哪段时间、推荐使用的 git 命令、忽略 merge commit 等。

resolver agent 的 prompt 额外要求：必须返回严格 JSON，格式为 `{ type: "resolved", repoPath, since, until, ... }` 或 `{ type: "need_clarification", question }`。宿主程序解析这个 JSON 后决定下一步。

#### 4. 事件流处理

Claude Agent SDK 的 `query()` 返回的不是一次性结果，而是一个异步事件流。主程序通过 `for await (const event of stream)` 读取事件，只关心两类：

- `system/init`：获取 session 初始化信息
- `result`：获取 agent 最终产出的 Markdown 文本

resolver agent 需要多轮追问时，主程序会手写一个最小异步消息队列，把用户的补充回答持续塞进同一条会话，而不是每次都新开一个 query。

#### 5. 运行时配置强制锁定

为了避免用户终端里残留的其他 Anthropic 兼容网关配置把请求带偏，程序内部会做三件事：

1. 只读取 `KIMI_API_KEY`，然后映射成 SDK 需要的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
2. 强制覆盖 `ANTHROPIC_BASE_URL` 为 `https://api.kimi.com/coding/`
3. 默认模型固定为 `kimi-for-coding`

这样无论用户 shell 里之前配过什么，这个 demo 都会稳定走 Kimi Coding Plan。

---

## 推荐演示组合（5 分钟版）

| 顺序 | 命令 | 展示重点 |
|---|---|---|
| 1 | `npm run report -- --repo=weass-b --since=... --until=...` | 极速精确，零交互出报告 |
| 2 | `npm run report` + 输入"帮我看下 weass b 上周提交" | 自然语言理解能力 |
| 3 | `npm run report` + 输入"帮我看下 weass 提交" | 模糊匹配 + 智能追问 |

---

## 环境要求

- Node.js 18+
- `KIMI_API_KEY`（自动映射到 Claude Agent SDK）
- 本地 `/Users/sunzhennan/Desktop/Code` 下有目标 Git 仓库

---

## 模型与网关

- 固定走 Kimi Coding Plan Anthropic 兼容接口
- Base URL: `https://api.kimi.com/coding/`
- 默认模型: `kimi-for-coding`
