# Claude Agent SDK 周报 Demo

这是一个独立的 TypeScript CLI demo。它会使用 Claude Agent SDK 分析本地 Git 仓库在一段时间内的非合并提交，并输出一份中文 Markdown 周报。

当前版本已经升级成“两阶段 agent”：

1. resolver agent 先理解你一句模糊的话，解析出仓库和时间
2. report agent 再进入目标仓库，读取 git 证据并生成中文周报

如果你想看“小白版逐步拆解、项目流程图和按执行顺序的源码导读”，直接打开 [PROJECT_WALKTHROUGH.md](./PROJECT_WALKTHROUGH.md)。

如果你想系统了解 Claude Agent SDK 本身能做什么，打开 [CLAUDE_AGENT_SDK_CAPABILITIES.md](./CLAUDE_AGENT_SDK_CAPABILITIES.md)。

这个版本已经改成“强制走 Kimi Coding Plan Anthropic 兼容接口”。

意思是：

- 你继续用的是 `Claude Agent SDK`
- 但程序不会再读取别家的兼容网关
- 它会固定连接 Kimi Coding Plan：`https://api.kimi.com/coding/`
- 默认兜底项目是：`/Users/sunzhennan/Desktop/Code/weass-b-mono`
- 也支持通过 `--repo=<关键词>` 在 `/Users/sunzhennan/Desktop/Code` 里模糊匹配自定义项目

## 目标

- 体现“agent 自己调用工具分析仓库”而不是单纯脚本统计
- 输出适合分享的中文总结、模块归类、风险点和验证建议
- 同时打印到终端，并写入 `reports/weekly-summary-<项目名>-<开始日期>-to-<结束日期>.md`

## 环境准备

1. Node.js 18+
2. Kimi Coding Plan API Key
3. 本机在 `/Users/sunzhennan/Desktop/Code` 下有可用的 Git 仓库

`.env.example` 只给最小配置示意。本项目会自动读取根目录的 `.env` 文件，所以如果 `.env` 已经写好了，就不需要每次手动 `export`。

## Kimi 配置

最简单的方式是在当前终端先执行：

```bash
export KIMI_API_KEY="你的 Kimi Coding Plan API Key"
export KIMI_MODEL="kimi-for-coding"
```

当前 demo 对外只认一个 key 变量名：

- `KIMI_API_KEY`

程序内部会自动把它映射成 SDK 需要的 `ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN`，所以你不用自己再配别的名字。

如果你不想每次都 `export`，也可以直接把下面这类内容写进项目根目录的 `.env`：

```bash
KIMI_API_KEY="你的 Kimi Coding Plan API Key"
KIMI_MODEL="kimi-for-coding"
```

说明：

- 程序会强制把 Base URL 设为 `https://api.kimi.com/coding/`
- 默认模型是 `kimi-for-coding`
- Kimi Coding Plan 这个套餐场景下通常不用改模型；如果官方后续给了新模型名，再用 `KIMI_MODEL` 覆盖
- 这套配置适用于 Kimi Coding Plan 的 Anthropic 兼容接口

## 安装

```bash
nvm use
npm install
```

如果你本机还没装项目要求的 Node 版本，先执行：

```bash
nvm install 22
nvm use
```

## 用法

最简单的运行方式是直接启动，然后在终端里输入一句自然语言：

```bash
nvm use
npm run report
```

例如你可以输入：

```text
帮我看下 weass b 上周提交
```

或者：

```text
帮我看下这周提交
```

第二种因为没说仓库，resolver agent 可能会先追问一次。

如果你已经明确知道项目，也可以只让 agent 帮你理解时间：

```bash
nvm use
npm run report -- --repo=weass-b
```

这时程序会继续让你输入一句话，比如：

```text
上周
```

如果你已经把时间也写死，就会直接跳过 resolver agent：

```bash
nvm use
npm run report -- --since=2026-03-30 --until=2026-04-01
```

同时指定项目和时间范围：

```bash
nvm use
npm run report -- --repo=weass-b --since=2026-03-30 --until=2026-04-01
```

注意：

- 所有参数都只支持 `--key=value` 写法
- 不传 `--repo` 时，会进入一句话输入模式
- 仓库已明确但时间完全没传时，也会进入一句话输入模式
- 只要 `--since` 或 `--until` 出现任意一个，时间就按 CLI 精确模式处理
- 显式参数优先于自然语言解析结果
- 不支持 `--repo weass-b`
- 不支持 `--since 2026-03-30`
- 不支持 `--until 2026-04-01`

支持的时间输入：

- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- `YYYY-MM-DD HH:mm:ss`
- 标准 ISO 时间

日期型输入默认按 `+08:00` 解释。

## 输出

- 终端输出完整 Markdown 报告
- 落盘到 `reports/weekly-summary-<项目名>-<开始日期>-to-<结束日期>.md`

## 说明

- 现在有两个 agent：
  - resolver agent：解析模糊仓库和时间
  - report agent：分析 git 并写周报
- resolver agent 的仓库搜索根目录固定为 `/Users/sunzhennan/Desktop/Code`
- resolver agent 优先看一级目录；必要时再向下一层扩一层
- 显式 `--repo=<关键词>` 仍然会走本地模糊匹配
- 本地模糊匹配规则固定为：`exact > startsWith > contains`
- 如果本地模糊匹配出现多个最佳候选：
  - TTY 终端里会让你交互选择
  - 非 TTY 环境下会打印候选并退出
- resolver agent 最多允许 2 轮追问；超过后会要求你改用更明确的输入
- report agent 仅开放 `Bash(git:*)` 与 `Read` 工具权限
- 启动时会打印当前使用的模型和 Base URL，方便你分享时解释“SDK 在前，Kimi 模型在后”
- 即使你当前 shell 里残留了别家的 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_MODEL`，程序也会覆盖成 Kimi 配置

## 非 TTY 提醒

如果当前不是交互式终端，而本次运行又需要自然语言输入或追问，程序会直接退出，并提示你改用显式参数。例如：

```bash
npm run report -- --repo=weass-b --since=2026-03-30 --until=2026-04-01
```

## 常见问题

### 为什么会报 `Object not disposable`

这通常不是 key 错，也不是 prompt 错，而是 **Node 版本太低**。

Claude Agent SDK 需要 `Node 18+`。如果你在项目目录里被上层目录的 `.nvmrc` 自动切到了 `Node 16`，就可能看到这个报错。

处理方式：

```bash
nvm install 22
nvm use
node -v
```

确认版本是 `18+` 之后，再重新运行：

```bash
npm run report -- --since=2026-03-30 --until=2026-04-01
```

### 为什么 `--repo weass-b` 会报错

因为当前版本把参数格式统一收紧成了 `--key=value`。

正确写法：

```bash
--repo=weass-b
--since=2026-03-30
--until=2026-04-01
```
