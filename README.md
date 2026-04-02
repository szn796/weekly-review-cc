# Claude Agent SDK 周报 Demo

这是一个独立的 TypeScript CLI demo。它会使用 Claude Agent SDK 分析本地 Git 仓库在一段时间内的非合并提交，并输出一份中文 Markdown 周报。不传 `--repo` 时默认分析 `/Users/sunzhennan/Desktop/Code/weass-b-mono`。

如果你想看“小白版逐步拆解、项目流程图和按执行顺序的源码导读”，直接打开 [PROJECT_WALKTHROUGH.md](./PROJECT_WALKTHROUGH.md)。

如果你想系统了解 Claude Agent SDK 本身能做什么，打开 [CLAUDE_AGENT_SDK_CAPABILITIES.md](./CLAUDE_AGENT_SDK_CAPABILITIES.md)。

这个版本已经改成“强制走阿里云百炼 Anthropic 兼容接口”。

意思是：

- 你继续用的是 `Claude Agent SDK`
- 但程序不会再读取别家的兼容网关
- 它会固定连接百炼：`https://dashscope.aliyuncs.com/apps/anthropic`
- 默认项目是：`/Users/sunzhennan/Desktop/Code/weass-b-mono`
- 也支持通过 `--repo=<关键词>` 在 `/Users/sunzhennan/Desktop/Code` 一级目录里模糊匹配自定义项目

## 目标

- 体现“agent 自己调用工具分析仓库”而不是单纯脚本统计
- 输出适合分享的中文总结、模块归类、风险点和验证建议
- 同时打印到终端，并写入 `reports/weekly-summary-<项目名>-<开始日期>-to-<结束日期>.md`

## 环境准备

1. Node.js 18+
2. 百炼 API Key
3. 本机在 `/Users/sunzhennan/Desktop/Code` 下有可用的 Git 仓库

`.env.example` 只给最小配置示意。本项目会自动读取根目录的 `.env` 文件，所以如果 `.env` 已经写好了，就不需要每次手动 `export`。

## 百炼配置

最简单的方式是在当前终端先执行：

```bash
export BAILIAN_API_KEY="你的百炼 API Key"
export BAILIAN_MODEL="qwen3.5-plus"
```

当前 demo 对外只认一个 key 变量名：

- `BAILIAN_API_KEY`

程序内部会自动把它映射成 SDK 需要的 `ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN`，所以你不用自己再配别的名字。

如果你不想每次都 `export`，也可以直接把下面这类内容写进项目根目录的 `.env`：

```bash
BAILIAN_API_KEY="你的百炼 API Key"
BAILIAN_MODEL="qwen3.5-plus"
```

说明：

- 程序会强制把 Base URL 设为 `https://dashscope.aliyuncs.com/apps/anthropic`
- 默认模型是 `qwen3.5-plus`
- 如果你想换百炼模型，用 `BAILIAN_MODEL` 改，不要再改别的网关变量
- 这套配置适用于阿里云百炼中国内地版北京地域的 Anthropic 兼容接口

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

默认分析“Asia/Shanghai 时区下，本周一 00:00 到当前时间”的提交：

```bash
nvm use
npm run report
```

指定自定义项目：

```bash
nvm use
npm run report -- --repo=weass-b
```

可选覆盖时间范围：

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

- 不传 `--repo` 时默认分析 `weass-b-mono`
- 传 `--repo=<关键词>` 时，只会在 `/Users/sunzhennan/Desktop/Code` 的一级子目录里找 Git 仓库
- 模糊匹配规则固定为：`exact > startsWith > contains`
- 如果最佳候选有多个：
  - TTY 终端里会让你交互选择
  - 非 TTY 环境下会打印候选并退出
- Agent 仅开放 `Bash(git:*)` 与 `Read` 工具权限
- 启动时会打印当前使用的模型和 Base URL，方便你分享时解释“SDK 在前，百炼模型在后”
- 即使你当前 shell 里残留了别家的 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_MODEL`，程序也会覆盖成百炼配置

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
