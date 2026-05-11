import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { resolveDateRange } from "./dateRange.js";
import {
  buildResolverSystemPrompt,
  buildResolverUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.js";

// `execFile` 比 `exec` 更适合这里：
// 1. 我们只是调用一个固定命令 `git`
// 2. 不需要 shell 解释，安全性更高
// 3. 参数数组传递更清晰，不容易被空格或特殊字符干扰
const execFile = promisify(execFileCallback);

// 当前 demo 默认分析一个本地仓库，同时允许通过 `--repo=<关键词>` 切换项目。
const DEFAULT_REPO_PATH = "/Users/sunzhennan/Desktop/Code/weass-b-mono";
// 自定义项目搜索范围固定在 Code 一级目录，避免递归搜索把结果变得太乱。
const DEFAULT_REPO_SEARCH_ROOT = "/Users/sunzhennan/Desktop/Code";
// 这里强制固定为 Kimi Coding Plan 的 Anthropic 兼容网关，避免用户终端里残留别家网关变量。
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/";
// Kimi Coding Plan 在 Claude Code / Anthropic 兼容场景下固定使用这个模型名。
const DEFAULT_KIMI_MODEL = "kimi-for-coding";
// `import.meta.url` 指向当前编译后的入口文件位置，这里往上一层就能拿到项目根目录。
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = path.join(PROJECT_ROOT, "reports");

// 命令行参数只保留当前 demo 真正需要的三类能力：
// 1. 指定项目关键词
// 2. 覆盖时间范围
// 3. 查看帮助
type CliArgs = {
  repoArg?: string;
  sinceArg?: string;
  untilArg?: string;
  help: boolean;
};

// Claude Agent SDK 在运行时会持续产出事件。
// 这里不需要把所有事件类型都完整建模，只保留当前项目真正会读到的关键字段：
// - system/init：拿 session 初始化信息
// - result：拿最终 Markdown 文本、turn 数、cost 等
type SdkEvent = {
  type?: string;
  subtype?: string;
  cwd?: string;
  tools?: string[];
  session_id?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
};

type DiscoveredRepo = {
  name: string;
  path: string;
};

type RepoMatch = DiscoveredRepo & {
  matchLevel: number;
};

// 这是"两阶段 agent"最终对外暴露的统一上下文。
// 主流程后面不再关心"这个仓库是命令行给的，还是 agent 猜出来的"，
// 只关心这里已经收敛好的 6 个字段。
//
// 你可以把它理解成：resolver 阶段的最终交付物。
type ResolvedAnalysisContext = {
  repoPath: string;
  repoName: string;
  since: string;
  until: string;
  humanRange: string;
  source: "explicit" | "agent" | "mixed";
};

// resolver agent 成功解析时必须返回这 5 个核心字段。
// 这里的结构故意做得很"硬"，是因为宿主程序要稳定消费 JSON。
// 如果让 agent 返回一段自然语言，主程序还要再猜一次，反而更不稳定。
type ResolverAgentResolved = {
  type: "resolved";
  repoPath: string;
  since: string;
  until: string;
  humanRange: string;
  summary: string;
};

// 当仓库或时间仍然不够明确时，resolver 不应该硬猜，
// 而应该明确要求宿主程序再向用户追问一句。
type ResolverAgentClarification = {
  type: "need_clarification";
  question: string;
};

type ResolverAgentOutput = ResolverAgentResolved | ResolverAgentClarification;

// `query()` 在多轮模式下，接收的其实不是普通字符串，而是一条条 user message。
// 当前项目只需要最小子集：
// - type 固定是 `user`
// - message 里只放一段文本
// - 不涉及 tool result，所以 `parent_tool_use_id` 固定为 null
type SdkUserInputMessage = {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  parent_tool_use_id: null;
};

/**
 * 整个 CLI 的主流程。
 *
 * 这一个函数把"从命令到报告"的链路串起来：
 * 1. 解析参数
 * 2. 准备 Kimi/SDK 运行环境
 * 3. 检查目标仓库
 * 4. 计算时间范围
 * 5. 调用 agent
 * 6. 把最终 Markdown 输出到终端并写到文件
 */
async function main(): Promise<void> {
  // 先检查 Node 版本。
  // 这是一个非常关键的前置条件，因为 Claude Agent SDK 明确要求 Node 18+。
  // 如果版本过低，继续往下跑只会得到很迷惑的内部错误，比如：
  // "Object not disposable"
  ensureSupportedNodeVersion();

  const cliArgs = parseCliArgs(process.argv.slice(2));
  
  // 输出帮助信息
  if (cliArgs.help) {
    printHelp();
    return;
  }

  // 在真正准备运行配置前，先尝试加载项目根目录的 `.env`。
  // 这样项目可以自带一份本地配置，用户之后只要进目录运行命令即可。
  await loadProjectEnvFile();

  // 先准备模型运行环境，再做别的事情。
  // 原因很简单：如果连 key 都没有，后面的仓库检查和时间计算都没有意义。
  const runtimeConfig = prepareRuntimeConfig();

  // 两阶段流程从这里开始：
  // 1. 如果仓库或时间信息不完整，先进入 resolver agent
  // 2. resolver 产出最终上下文后，再进入 report agent
  const analysisContext = await resolveAnalysisContext(cliArgs, runtimeConfig.model);

  // 这些启动信息是特意打印给"演示场景"看的：
  // - 你可以现场确认正在分析哪个仓库
  // - 你可以说明当前用的是 Kimi Coding Plan 哪个模型
  // - 你可以证明程序确实被锁定到了 Kimi Coding Plan 网关
  console.log(`目标仓库: ${analysisContext.repoPath}`);
  console.log(`分析范围: ${analysisContext.humanRange}`);
  console.log(`上下文来源: ${analysisContext.source}`);
  console.log(`模型网关: ${runtimeConfig.baseUrl}`);
  console.log(`模型名称: ${runtimeConfig.model}`);
  console.log("正在调用 Claude Code SDK 分析提交...\n");

  // 这里真正进入 Agent 阶段。
  // 进入后，主程序自己不再手写 `git log` / `git show` 的业务逻辑，
  // 而是把任务和约束交给 Claude Agent SDK。
  const report = await runWeeklyReportAgent({
    repoPath: analysisContext.repoPath,
    since: analysisContext.since,
    until: analysisContext.until,
    humanRange: analysisContext.humanRange,
    model: runtimeConfig.model,
  });

  // `reports/` 目录可能还不存在，所以先确保目录存在再写文件。
  await mkdir(REPORTS_DIR, { recursive: true });
  const outputPath = path.join(
    REPORTS_DIR,
    buildReportFileName(analysisContext.repoPath, analysisContext.since, analysisContext.until),
  );
  await writeFile(outputPath, `${report.markdown.trim()}\n`, "utf8");

  // 终端打印 + 文件落盘，两条路径都保留：
  // - 终端适合 live demo
  // - Markdown 文件适合分享前复盘和归档
  console.log(report.markdown.trim());
  console.log("\n---");
  console.log(`报告已写入: ${outputPath}`);
  if (report.sessionId) {
    console.log(`Session ID: ${report.sessionId}`);
  }
  if (typeof report.turns === "number") {
    console.log(`Turns: ${report.turns}`);
  }
  if (typeof report.costUsd === "number") {
    console.log(`Cost (USD): ${report.costUsd.toFixed(4)}`);
  }
}

/**
 * 统一解析"这次到底要分析哪个仓库、哪段时间"。
 *
 * 这是本次升级的核心：
 * - 显式参数足够时，直接按 CLI 精确模式走
 * - 仓库或时间信息不完整时，先进入 resolver agent
 * - 最终对外只暴露一个稳定的结构化上下文
 *
 * 你可以把这个函数理解成"总调度员"。
 *
 * 例子 1：
 * 用户执行：
 * `npm run report -- --repo=weass-b --since=2026-03-30 --until=2026-04-01`
 *
 * 这时：
 * - 仓库有了
 * - 时间也有了
 * - 就不需要 resolver agent
 * - 直接返回：
 *   {
 *     repoPath: ".../weass-b-mono",
 *     since: "2026-03-30T00:00:00+08:00",
 *     until: "2026-04-01T23:59:59+08:00",
 *     ...
 *   }
 *
 * 例子 2：
 * 用户执行：
 * `npm run report`
 *
 * 然后在终端输入：
 * `帮我看下 weass b 上周提交`
 *
 * 这时：
 * - 仓库没显式给
 * - 时间也没显式给
 * - 所以先进入 resolver agent
 * - resolver 负责把"weass b + 上周"解析成真实仓库路径和具体时间
 */
async function resolveAnalysisContext(
  cliArgs: CliArgs,
  model: string,
): Promise<ResolvedAnalysisContext> {
  // 先把"用户到底有没有显式给信息"拆成布尔值。
  // 这样后面的分支会清楚很多，不至于到处写 `if (cliArgs.repoArg)` 这种重复判断。
  const hasExplicitRepo = Boolean(cliArgs.repoArg);
  const hasExplicitSince = Boolean(cliArgs.sinceArg);
  const hasExplicitUntil = Boolean(cliArgs.untilArg);
  const hasAnyExplicitTime = hasExplicitSince || hasExplicitUntil;

  // 到这里，这 4 个布尔值可能长这样：
  //
  // 场景 A：`npm run report`
  // hasExplicitRepo = false
  // hasExplicitSince = false
  // hasExplicitUntil = false
  // hasAnyExplicitTime = false
  //
  // 场景 B：`npm run report -- --repo=weass-b`
  // hasExplicitRepo = true
  // hasExplicitSince = false
  // hasExplicitUntil = false
  // hasAnyExplicitTime = false
  //
  // 场景 C：`npm run report -- --repo=weass-b --since=2026-03-30`
  // hasExplicitRepo = true
  // hasExplicitSince = true
  // hasExplicitUntil = false
  // hasAnyExplicitTime = true

  // 显式传了 `--repo` 时，仍然复用现有的本地模糊匹配逻辑。
  // 这样高级用法依旧稳定，而且不必额外消耗一次模型调用去找仓库。
  const explicitRepoPath = hasExplicitRepo ? await resolveRepoPath(cliArgs.repoArg) : undefined;

  // `explicitRepoPath` 在真实运行里可能长这样：
  // "/Users/sunzhennan/Desktop/Code/weass-b-mono"
  //
  // 如果用户没传 `--repo`，它就是 `undefined`。

  // 进入 resolver agent 的触发规则：
  // 1. 没传 `--repo`
  // 2. 仓库虽然明确了，但时间完全没传
  //
  // 只要 `--since` / `--until` 里任意一个出现，就说明"时间已经进入精确模式"，
  // 另一侧缺口让 `resolveDateRange()` 按已有默认规则补齐即可，
  // 没必要再为了时间重新走自然语言解析。
  const shouldUseResolver = !hasExplicitRepo || !hasAnyExplicitTime;

  let resolverOutput: ResolverAgentResolved | undefined;
  if (shouldUseResolver) {
    // 先拿到"用户一句话输入"。
    // 注意这里不是直接调 agent，而是先把需要的补充信息从终端里收上来。
    const userIntent = await collectUserIntent({
      hasExplicitRepo,
      hasAnyExplicitTime,
      hasExplicitSince,
      hasExplicitUntil,
    });

    // 这里才真正进入 resolver agent。
    // 同时把 CLI 已经锁定的字段传进去，避免 agent 擅自覆盖显式参数。
    resolverOutput = await runIntentResolverAgent({
      model,
      userIntent,
      lockedRepoPath: explicitRepoPath,
      lockedSince: hasExplicitSince ? cliArgs.sinceArg : undefined,
      lockedUntil: hasExplicitUntil ? cliArgs.untilArg : undefined,
    });
  }

  // 到这里有两种来源：
  // 1. 仓库来自显式参数：`explicitRepoPath`
  // 2. 仓库来自 resolver：`resolverOutput.repoPath`
  //
  // 所以这里做一次"二选一"。
  const rawRepoPath = explicitRepoPath ?? resolverOutput?.repoPath;
  if (!rawRepoPath) {
    throw new Error("无法确定要分析的仓库，请改用更明确的表达或使用 `--repo=<关键词>`。");
  }

  // 如果仓库来自 agent，需要额外做一次路径归一化和安全边界检查；
  // 如果仓库本来就是 CLI 显式选中的，则直接用即可。
  const normalizedRepoPath = explicitRepoPath
    ? explicitRepoPath
    : normalizeResolverRepoPath(rawRepoPath);
  const verifiedRepoPath = await ensureGitRepo(normalizedRepoPath);

  // 只要显式时间参数出现了任意一个，就按 CLI 精确模式处理；
  // resolver 即使给出时间，也不会覆盖显式边界。
  const dateRange = hasAnyExplicitTime
    ? resolveDateRange({
        sinceArg: cliArgs.sinceArg,
        untilArg: cliArgs.untilArg,
      })
    : resolveDateRange({
        sinceArg: resolverOutput?.since,
        untilArg: resolverOutput?.until,
      });

  // `dateRange` 会变成这种已经标准化后的结构：
  // {
  //   since: "2026-03-30T00:00:00+08:00",
  //   until: "2026-04-01T23:59:59+08:00",
  //   reportDate: "2026-04-01",
  //   humanRange: "2026-03-30 00:00 ~ 2026-04-01 23:59 (Asia/Shanghai)"
  // }
  //
  // 后面 report agent 不再关心"用户原话是上周还是最近三天"，
  // 它只认这种已经算好的精确时间。

  return {
    repoPath: verifiedRepoPath,
    repoName: path.basename(verifiedRepoPath),
    since: dateRange.since,
    until: dateRange.until,
    humanRange: dateRange.humanRange,
    source: determineContextSource(shouldUseResolver, hasExplicitRepo, hasAnyExplicitTime),
  };
}

/**
 * 在需要时收集一句话自然语言输入。
 *
 * 这里刻意不新增 `--ask=` 一类参数，而是让用户直接在终端里输入一句话，
 * 更符合"现场演示 agent 自己理解需求"的效果。
 */
async function collectUserIntent(input: {
  hasExplicitRepo: boolean;
  hasAnyExplicitTime: boolean;
  hasExplicitSince: boolean;
  hasExplicitUntil: boolean;
}): Promise<string> {
  // 自然语言交互必须发生在可交互终端里。
  // 如果现在是 CI / 重定向 / 后台任务这种非 TTY 环境，就不要继续问了，
  // 直接提示用户改成显式参数。
  ensureInteractiveCli(
    "当前参数不足以直接确定仓库和时间，请在 TTY 终端里运行，或改用显式参数。",
  );

  // 默认问题：让用户同时说仓库和时间。
  let question = "请用一句话描述你想分析的仓库和时间，例如：帮我看下 weass b 上周提交\n> ";
  // `allowEmptyAnswer` 只在"仓库已经锁定、时间完全没传"的场景开放。
  // 这时用户直接回车，我们就把它理解成"请按默认本周处理"。
  let allowEmptyAnswer = false;

  if (input.hasExplicitRepo && !input.hasAnyExplicitTime) {
    question =
      "请用一句话描述你想分析的时间，例如：上周、最近三天、清明前后。直接回车则默认本周\n> ";
    allowEmptyAnswer = true;
  } else if (!input.hasExplicitRepo && input.hasAnyExplicitTime) {
    const lockedTimeParts = [
      input.hasExplicitSince ? "`--since`" : undefined,
      input.hasExplicitUntil ? "`--until`" : undefined,
    ].filter(Boolean);
    question = `时间范围里已有 ${lockedTimeParts.join(" / ")}，请再用一句话描述仓库，例如：帮我看下 weass b\n> `;
  }

  // 这里的 `question` 最终可能会变成 3 种样子：
  //
  // 1. 默认场景：
  // "请用一句话描述你想分析的仓库和时间..."
  //
  // 2. 仓库已给、时间没给：
  // "请用一句话描述你想分析的时间..."
  //
  // 3. 时间已给、仓库没给：
  // "时间范围里已有 --since / --until，请再用一句话描述仓库..."

  const answer = await askCliQuestion(question);
  if (answer) {
    // 用户输入的内容可能就是：
    // "帮我看下 weass b 上周提交"
    // 或者：
    // "最近三天"
    // 或者：
    // "订单项目"
    return answer;
  }

  // 只有"仓库已明确、时间为空"这个场景才允许空回答，
  // 因为默认本周是一个可解释、可预测的兜底行为。
  if (allowEmptyAnswer) {
    return "请按本周处理。";
  }

  throw new Error("未提供足够的自然语言输入，请改用更明确的描述，或显式传入 `--repo=<关键词>`。");
}

/**
 * 使用 resolver agent 解析模糊意图。
 *
 * 这里虽然仍然用 `query()`，但 prompt 不再是一句固定字符串，
 * 而是一个可持续推送消息的异步队列：
 * - 第一次推送用户初始模糊需求
 * - 如果 agent 需要澄清，再继续往同一条会话里补充用户回答
 * - 这样既保留完整 options，又能实现真正的多轮解析
 */
async function runIntentResolverAgent(input: {
  model: string;
  userIntent: string;
  lockedRepoPath?: string;
  lockedSince?: string;
  lockedUntil?: string;
}): Promise<ResolverAgentResolved> {
  // 这里没有直接把字符串 prompt 传给 `query()`，
  // 而是先创建一个"可持续塞消息进去"的异步队列。
  //
  // 原因是这次 resolver 不是单轮：
  // 1. 第一次先把模糊需求塞进去
  // 2. 如果 agent 说信息不足，要追问
  // 3. 宿主程序再把用户补充输入塞进同一条会话
  //
  // 这样才能满足"最多 2 轮 clarification，且不要每次都重开新黑盒"的要求。
  const messageQueue = createUserMessageQueue();
  messageQueue.push(
    buildResolverUserPrompt({
      userIntent: input.userIntent,
      repoSearchRoot: DEFAULT_REPO_SEARCH_ROOT,
      shanghaiNow: formatShanghaiPromptNow(new Date()),
      lockedRepoPath: input.lockedRepoPath,
      lockedSince: input.lockedSince,
      lockedUntil: input.lockedUntil,
    }),
  );

  // 这里第一次塞进去的不是"简单一句话"，
  // 而是一整段 resolver user prompt。
  //
  // 它大概长这样：
  //
  // 当前时间（Asia/Shanghai）：2026-04-02 22:10:03
  // 仓库搜索根目录：/Users/sunzhennan/Desktop/Code
  // 用户原始需求：帮我看下 weass b 上周提交
  // lockedRepoPath：(未锁定)
  // lockedSince：(未锁定)
  // lockedUntil：(未锁定)
  //
  // 也就是说，resolver agent 看到的不是孤零零一句"weass b 上周提交"，
  // 而是一份上下文更完整的任务单。

  const resolverQuery = query({
    prompt: messageQueue.messages,
    options: {
      // resolver 阶段必须在代码根目录附近工作，
      // 这样它用 `ls` / `find` / `git` 时看到的是仓库搜索区，而不是当前 demo 自己。
      cwd: DEFAULT_REPO_SEARCH_ROOT,
      // resolver 通常不需要太多轮，这里给 10 轮是比较保守的上限，
      // 防止 agent 在异常情况下无限兜圈子。
      maxTurns: 10,
      // 这个 CLI demo 只需要模型和受控工具，不需要加载本机 Claude Code 插件、MCP、IDE 自动连接等能力。
      // `--bare` 可以减少启动副作用，避免第三方本机配置让 SDK 事件流长时间没有输出。
      extraArgs: { bare: null },
      permissionMode: "acceptEdits",
      allowedTools: [
        "Bash(pwd:*)",
        "Bash(ls:*)",
        "Bash(find:*)",
        "Bash(git:*)",
        "Bash(cat:*)",
        "Read",
      ],
      systemPrompt: buildResolverSystemPrompt(),
      model: input.model,
    },
  });

  const iterator = (resolverQuery as AsyncIterable<SdkEvent>)[Symbol.asyncIterator]();

  try {
    // 第一次等待 resolver 的回答：
    // - 要么直接解析成功
    // - 要么返回 `need_clarification`
    let resolverOutput = parseResolverAgentOutput(
      await waitForSessionResult(iterator),
    );

    // `resolverOutput` 在第一次返回时，通常会是两种结构之一：
    //
    // 1. 已经足够明确，直接成功：
    // {
    //   type: "resolved",
    //   repoPath: "/Users/.../weass-b-mono",
    //   since: "2026-03-23T00:00:00+08:00",
    //   until: "2026-03-29T23:59:59+08:00",
    //   humanRange: "...",
    //   summary: "用户想看 weass-b-mono 上周提交"
    // }
    //
    // 2. 信息不够，还要追问：
    // {
    //   type: "need_clarification",
    //   question: "你想看哪个 weass 项目？"
    // }

    let clarificationCount = 0;

    while (resolverOutput.type === "need_clarification") {
      clarificationCount += 1;
      // 最多只允许 2 轮追问，避免交互拖得太长，也避免 agent 一直兜圈子。
      if (clarificationCount > 2) {
        throw new Error("连续 2 轮追问后仍无法确定仓库或时间，请改用更明确的表达或显式参数。");
      }

      ensureInteractiveCli("resolver agent 需要继续追问，请在 TTY 终端里运行，或改用显式参数。");
      const answer = await askCliQuestion(`${resolverOutput.question.trim()}\n> `);
      if (!answer) {
        throw new Error("未提供补充信息，无法继续解析仓库和时间。");
      }

      // 这里不是开新 query，而是把补充输入继续塞进同一条 resolver 会话。
      //
      // 比如刚才 agent 问：
      // "你想看哪个 weass 项目？"
      //
      // 用户回答：
      // "weass-b-mono"
      //
      // 这里塞进去的就是 `"weass-b-mono"` 这句文本。
      messageQueue.push(answer);
      resolverOutput = parseResolverAgentOutput(
        await waitForSessionResult(iterator),
      );
    }

    return resolverOutput;
  } finally {
    // 无论成功还是失败，都要把输入流和 query 主动收掉。
    // 否则底层进程可能还在等待后续消息。
    messageQueue.close();
    resolverQuery.close();
  }
}

function createUserMessageQueue(): {
  messages: AsyncIterable<SdkUserInputMessage>;
  push: (text: string) => void;
  close: () => void;
} {
  // 这个函数本质上是在手写一个"最小异步消息队列"。
  //
  // 为什么需要它？
  // 因为 `query()` 的 prompt 不仅能吃一个字符串，也能吃 `AsyncIterable<SDKUserMessage>`。
  // 这意味着：
  // - Claude 端在等下一条用户消息
  // - 宿主程序可以稍后再把消息塞进去
  //
  // 正是靠这个能力，我们才能在同一条 resolver 会话里做多轮追问。
  //
  // 你可以把这个队列想成一个"聊天输入框缓存"：
  // - `push("帮我看下 weass b 上周提交")`
  // - agent 读走这句话
  // - agent 追问后
  // - `push("weass-b-mono")`
  // - agent 再读走这句
  const bufferedMessages: SdkUserInputMessage[] = [];
  const waitingResolvers: Array<(result: IteratorResult<SdkUserInputMessage>) => void> = [];
  let closed = false;

  // 运行过程中，这 3 个变量可以这样理解：
  //
  // 1. `bufferedMessages`
  //    还没被 agent 取走的用户消息
  //    例子：
  //    [
  //      { type: "user", message: { role: "user", content: "帮我看下 weass b 上周提交" }, ... }
  //    ]
  //
  // 2. `waitingResolvers`
  //    agent 正在等下一条消息时，挂起来的"等待回调"
  //
  // 3. `closed`
  //    这个输入流是不是已经结束了

  // `flush()` 负责把"已经塞进缓冲区的消息"尽快交给正在等待的消费者。
  // 你可以把它理解成一个小型调度器。
  //
  // 更白话一点：
  // - 如果 agent 正在等消息
  // - 而我们手里正好有新消息
  // - 那就立刻把这条消息交出去
  const flush = (): void => {
    while (waitingResolvers.length > 0) {
      const resolveNext = waitingResolvers.shift();
      if (!resolveNext) {
        return;
      }

      const nextMessage = bufferedMessages.shift();
      if (nextMessage) {
        // 这里相当于：
        // "你在等消息对吧？我这里正好有一条，给你。"
        resolveNext({ value: nextMessage, done: false });
        continue;
      }

      if (closed) {
        // 这里相当于：
        // "没有更多消息了，整个输入流结束。"
        resolveNext({ value: undefined, done: true });
      } else {
        // 这里相当于：
        // "现在还没新消息，但流没结束，你继续等一会儿。"
        waitingResolvers.unshift(resolveNext);
      }
      return;
    }
  };

  return {
    messages: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SdkUserInputMessage>> {
            // 如果缓冲区里已经有消息，就立刻交出去。
            const nextMessage = bufferedMessages.shift();
            if (nextMessage) {
              return Promise.resolve({ value: nextMessage, done: false });
            }

            // 如果已经关闭且没有剩余消息，就告诉消费者"流结束了"。
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }

            // 否则说明现在暂时没消息，但未来可能还会有，
            // 就把当前消费者挂起，等 `push()` 进来后再唤醒。
            return new Promise(resolve => {
              waitingResolvers.push(resolve);
            });
          },
        };
      },
    },
    push(text: string) {
      if (closed) {
        throw new Error("内部消息队列已关闭，无法继续发送用户输入。");
      }

      // 这里把一段普通文本包装成 SDK 认识的 user message 结构。
      //
      // 例如：
      // 传进来的 `text` 是：
      // "最近三天"
      //
      // 包装后会变成：
      // {
      //   type: "user",
      //   message: {
      //     role: "user",
      //     content: "最近三天"
      //   },
      //   parent_tool_use_id: null
      // }
      bufferedMessages.push({
        type: "user",
        message: {
          role: "user",
          content: text,
        },
        parent_tool_use_id: null,
      });
      flush();
    },
    close() {
      // 关闭时也要 `flush()` 一次，
      // 这样那些还在等消息的消费者才能收到 done=true，而不是一直卡住。
      closed = true;
      flush();
    },
  };
}

// 从已有的异步迭代器中一直读到本轮真正的 `result` 事件。
// 注意：这里传入的是 iterator 而不是 AsyncIterable，
// 因为 SDK 返回的流只能消费一次，多次 `for await...of` 会导致后续轮次读不到事件。
async function waitForSessionResult(iterator: AsyncIterator<SdkEvent>): Promise<string> {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      throw new Error("resolver agent 没有返回最终结果。");
    }

    const event = next.value;
    if (event.type !== "result") {
      continue;
    }

    if (event.is_error) {
      const subtype = event.subtype ? ` (${event.subtype})` : "";
      throw new Error(`resolver agent 执行失败${subtype}。`);
    }

    const result = (event.result ?? "").trim();
    if (!result) {
      throw new Error("resolver agent 返回了空结果。");
    }

    return result;
  }
}

// 把 resolver 返回的 JSON 文本解析成宿主可消费的结构。
function parseResolverAgentOutput(raw: string): ResolverAgentOutput {
  // 虽然 prompt 已经要求"只返回 JSON"，
  // 但真实模型偶尔还是可能包上 ```json 代码块，或者带一点额外前后缀，
  // 所以这里先做一次尽量稳妥的文本提取。
  //
  // `raw` 可能长这样：
  // 1. 理想情况：
  //    {"type":"resolved","repoPath":"...","since":"...","until":"...","humanRange":"...","summary":"..."}
  //
  // 2. 不太听话的情况：
  //    ```json
  //    {"type":"need_clarification","question":"你想看哪个项目？"}
  //    ```
  const jsonText = extractJsonText(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // 先尝试自动修复常见的 JSON 格式问题（如字符串值内未转义的引号）
    const repaired = tryRepairJson(jsonText);
    if (repaired !== null) {
      parsed = repaired;
    } else {
      // 再退到最后防线：用正则提取已知字段
      const extracted = tryExtractFlatJson(jsonText);
      if (extracted !== null) {
        parsed = extracted;
      } else {
        throw new Error(`resolver agent 返回了非法 JSON：${raw}`);
      }
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("resolver agent 返回的 JSON 结构无效。");
  }

  const type = readRequiredString(parsed, "type");
  if (type === "need_clarification") {
    return {
      type,
      question: readRequiredString(parsed, "question"),
    };
  }

  if (type === "resolved") {
    return {
      type,
      repoPath: readRequiredString(parsed, "repoPath"),
      since: readRequiredString(parsed, "since"),
      until: readRequiredString(parsed, "until"),
      humanRange: readRequiredString(parsed, "humanRange"),
      summary: readRequiredString(parsed, "summary"),
    };
  }

  throw new Error(`resolver agent 返回了不支持的 type：${type}`);
}

/**
 * 尝试修复 resolver agent 返回的常见 JSON 格式错误。
 *
 * 最典型的问题是：字符串值内部包含未转义的双引号。
 * 例如：{"summary":"将"企助"理解为..."}
 *
 * 修复策略（按可靠性排序）：
 * 1. 把字符串值里的中文引号「」替换掉，避免干扰
 * 2. 用状态机扫描，把字符串值内未转义的 ASCII 双引号替换为中文引号「」
 * 3. 重新尝试 JSON.parse
 */
function tryRepairJson(raw: string): unknown | null {
  // 先去掉中文引号「」，避免它们被误当成字符串边界
  let repaired = raw.replace(/「/g, "'").replace(/」/g, "'");

  // 状态机：扫描字符串值，把内部未转义的 " 替换为 \"
  let inString = false;
  let escaped = false;
  const chars: string[] = [];

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    if (char === undefined) {
      continue;
    }

    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      chars.push(char);
      continue;
    }

    // 现在在字符串内部
    if (escaped) {
      escaped = false;
      chars.push(char);
      continue;
    }

    if (char === '\\') {
      escaped = true;
      chars.push(char);
      continue;
    }

    if (char === '"') {
      // 这是字符串的结束引号
      inString = false;
      chars.push(char);
      continue;
    }

    // 字符串内部的普通字符；如果它是未转义的 ASCII 双引号，替换成中文引号
    if (char === '"') {
      chars.push('「');
    } else {
      chars.push(char);
    }
  }

  repaired = chars.join('');

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/**
 * 最后防线：用正则从类 JSON 文本中提取已知字段。
 *
 * 当 JSON.parse 和 tryRepairJson 都失败时，
 * 我们对 resolver 的预期输出结构足够了解（扁平对象、字符串值），
 * 可以直接用正则提取关键字段，避免因为格式问题整轮失败。
 */
function tryExtractFlatJson(raw: string): Record<string, string> | null {
  const result: Record<string, string> = {};

  // 匹配 "key":"value" 或 "key":"value with \\"escaped\\" quotes"
  // 这个正则故意写得保守，只处理最常见的情况
  const pattern = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    const value = rawValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    result[key] = value;
  }

  // 至少要有 type 字段才算成功
  if (!result.type) {
    return null;
  }

  return result;
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  // 最理想情况：模型老老实实只返回一个 JSON 对象。
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // 兼容 ```json ... ``` 代码块。
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  // 再退一步：从第一对大括号之间粗略截出 JSON 体。
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function readRequiredString(
  value: object,
  key: "type" | "question" | "repoPath" | "since" | "until" | "humanRange" | "summary",
): string {
  // 这里统一做"字段存在且非空字符串"的校验。
  // 这样一旦 agent 少吐了字段，错误信息会更集中、更好懂。
  const raw = Reflect.get(value, key);
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`resolver agent 返回缺少字段：${key}`);
  }

  return raw.trim();
}

function normalizeResolverRepoPath(rawRepoPath: string): string {
  // resolver 返回的路径有两种可能：
  // 1. 已经是绝对路径
  // 2. 只是相对搜索根目录的一个路径片段
  //
  // 这里统一把它规整成绝对路径，再做安全边界校验。
  const trimmed = rawRepoPath.trim();
  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(DEFAULT_REPO_SEARCH_ROOT, trimmed);
  const normalizedSearchRoot = path.resolve(DEFAULT_REPO_SEARCH_ROOT);
  const searchRootPrefix = `${normalizedSearchRoot}${path.sep}`;

  if (absolutePath !== normalizedSearchRoot && !absolutePath.startsWith(searchRootPrefix)) {
    throw new Error(
      `resolver agent 返回的仓库路径超出允许范围：${absolutePath}\n允许范围: ${normalizedSearchRoot}`,
    );
  }

  return absolutePath;
}

function determineContextSource(
  usedResolver: boolean,
  hasExplicitRepo: boolean,
  hasAnyExplicitTime: boolean,
): ResolvedAnalysisContext["source"] {
  // 这个字段主要是给日志和演示看的。
  // 你可以通过它快速解释：
  // - 这次完全靠显式参数
  // - 完全靠 agent 理解
  // - 还是显式参数 + agent 混合完成
  if (!usedResolver) {
    return "explicit";
  }

  return hasExplicitRepo || hasAnyExplicitTime ? "mixed" : "agent";
}

function ensureInteractiveCli(errorMessage: string): void {
  // `stdin` / `stdout` 只要有一个不是 TTY，就说明这次运行不适合做现场问答。
  // 常见场景包括：重定向输出、CI、脚本调用等。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${errorMessage}\n请改用显式参数运行，例如：--repo=weass-b --since=2026-03-30 --until=2026-04-01`);
  }
}

async function askCliQuestion(question: string): Promise<string> {
  // `createInterface()` 是 Node 里做命令行问答的标准方式：
  // - 从 `stdin` 读用户输入
  // - 把问题打印到 `stdout`
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // `question()` 会暂停程序，直到用户敲回车。
    return (await readline.question(question)).trim();
  } finally {
    // 读完一定要关闭 interface，避免句柄残留。
    readline.close();
  }
}

function formatShanghaiPromptNow(now: Date): string {
  // 这里不是给 git 用，而是给 resolver prompt 当"当前参考时间"用。
  // resolver 需要根据"现在是什么时候"来理解"上周 / 最近三天 / 清明前后"这类相对时间。
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(/\//g, "-");
}

/**
 * 调用 Claude Agent SDK 执行一次"本周提交分析"任务。
 *
 * 这里的思路不是"我自己写 git 命令并自己总结"，而是：
 * 1. 主程序把任务交给 agent
 * 2. 主程序只开放受控工具给 agent
 * 3. agent 自己决定如何收集证据和组织结论
 *
 * 返回值是主程序真正关心的三类信息：
 * - markdown：最终报告正文
 * - sessionId：本次 SDK 会话 ID
 * - turns / cost：方便分享时解释一次 agent 跑了多少轮、花了多少成本
 */
async function runWeeklyReportAgent(input: {
  repoPath: string;
  since: string;
  until: string;
  humanRange: string;
  model: string;
}): Promise<{
  markdown: string;
  sessionId?: string;
  turns?: number;
  costUsd?: number;
}> {
  // `query()` 是 Agent SDK 最核心的入口：
  // 给它 prompt + options，它会持续返回事件流，直到任务完成。
  const stream = query({
    prompt: buildUserPrompt(input),
    options: {
      // 把 agent 的工作目录固定到目标仓库，这样它执行 `git` 命令时就在正确目录里。
      cwd: input.repoPath,
      // 限制最大轮数，避免 agent 在异常情况下无限循环。
      maxTurns: 8,
      // 这个 CLI demo 只依赖当前 options 显式传入的 prompt、cwd、tools 和 model。
      // `--bare` 让 Claude Code 子进程跳过无关的本机扩展初始化，降低卡在启动阶段的概率。
      extraArgs: { bare: null },
      // 当前 demo 只做读仓库 + 生成报告，不涉及主动改代码。
      // 这里保留 `acceptEdits` 是为了使用 SDK 的标准非交互模式；
      // 真正的安全边界主要由 `allowedTools` 控制。
      permissionMode: "acceptEdits",
      // 只开放 `git` 相关 bash 命令和文件读取能力。
      // 这是故意缩小工具面，保证 demo 的可控性和可解释性。
      allowedTools: ["Bash(git:*)", "Read"],
      // system prompt 负责"长期规则"，user prompt 负责"这次任务输入"。
      systemPrompt: buildSystemPrompt(),
      model: input.model,
    },
  }) as AsyncIterable<SdkEvent>;

  let initEvent: SdkEvent | undefined;
  let resultEvent: SdkEvent | undefined;

  // SDK 会在运行过程中吐出很多事件，我们这里只挑自己需要的两类：
  // 1. init：拿到初始化后的会话信息
  // 2. result：拿到真正的最终结果
  for await (const event of stream) {
    if (event.type === "system" && event.subtype === "init") {
      initEvent = event;
      continue;
    }

    if (event.type === "result") {
      resultEvent = event;
    }
  }

  // 如果连 result 都没拿到，说明这次调用没有正常完成。
  if (!resultEvent) {
    throw new Error("Claude Code SDK 没有返回最终结果。");
  }

  // SDK 的最终事件分 success / error 两大类。
  // 这里统一转成更适合 CLI 用户理解的错误信息。
  if (resultEvent.is_error) {
    const subtype = resultEvent.subtype ? ` (${resultEvent.subtype})` : "";
    throw new Error(`Claude Code SDK 执行失败${subtype}。`);
  }

  // 当前 demo 的最终产物必须是一段 Markdown 正文，所以空字符串也视为失败。
  const markdown = (resultEvent.result ?? "").trim();
  if (!markdown) {
    throw new Error("Claude Code SDK 返回了空结果。");
  }

  return {
    markdown,
    sessionId: resultEvent.session_id ?? initEvent?.session_id,
    turns: resultEvent.num_turns,
    costUsd: resultEvent.total_cost_usd,
  };
}

/**
 * 统一准备运行时环境。
 *
 * 这里做了两件很关键的事：
 * 1. 只读取当前 demo 约定的 `KIMI_API_KEY`
 * 2. 强制把 Anthropic 兼容网关锁死到 Kimi Coding Plan，避免被其他环境变量污染
 *
 * 这是当前项目"能稳定跑在 Kimi Coding Plan 上"的核心。
 */
function prepareRuntimeConfig(): { baseUrl: string; model: string } {
  // 当前 demo 只认一个对使用者最直观的变量名：`KIMI_API_KEY`。
  // 找到以后，再由程序内部映射成 SDK 习惯读取的 Anthropic 变量名。
  const kimiApiKey = process.env.KIMI_API_KEY?.trim();

  if (!kimiApiKey) {
    throw new Error(
      [
        "缺少 API Key。",
        "这个 demo 现在默认走 Kimi Coding Plan Anthropic 兼容接口。",
        "请至少设置以下环境变量后再运行：KIMI_API_KEY。",
      ].join(" "),
    );
  }

  // Claude Agent SDK 仍然按 Anthropic 协议读取认证变量；
  // Kimi Coding Plan 提供的是兼容接口，所以这里把 Kimi Key 映射到 SDK 会读取的字段。
  process.env.ANTHROPIC_API_KEY = kimiApiKey;
  process.env.ANTHROPIC_AUTH_TOKEN = kimiApiKey;

  // 强制覆盖 Base URL，避免 shell 里残留的其他 Anthropic 兼容网关把请求带偏。
  process.env.ANTHROPIC_BASE_URL = DEFAULT_KIMI_BASE_URL;

  // 模型只认我们自己定义的 `KIMI_MODEL`，这样语义更清楚，也不容易跟别家环境变量混淆。
  const model = process.env.KIMI_MODEL?.trim() || DEFAULT_KIMI_MODEL;

  return {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  };
}

/**
 * 检查当前 Node 版本是否满足 Claude Agent SDK 的最低要求。
 *
 * 这一步放在最前面，是为了把"环境问题"和"业务逻辑问题"区分开：
 * - 如果 Node 太旧，就直接用清楚的中文提示拦住
 * - 不要让用户跑到 SDK 内部后才看到难懂的报错
 */
function ensureSupportedNodeVersion(): void {
  const [majorText] = process.versions.node.split(".");
  const major = Number.parseInt(majorText ?? "", 10);

  if (Number.isNaN(major) || major < 18) {
    throw new Error(
      [
        `当前 Node 版本过低: ${process.versions.node}。`,
        "Claude Agent SDK 要求 Node 18+。",
      ].join(" "),
    );
  }
}

/**
 * 读取项目根目录的 `.env` 文件，并把其中的键值对注入到 `process.env`。
 *
 * 这里不用额外引入 `dotenv` 依赖，原因是：
 * 1. 当前 demo 只需要很基础的 KEY=VALUE 解析能力
 * 2. 减少依赖，更容易给小白讲清楚启动过程
 * 3. `.env` 只在项目根目录这一处读取，逻辑足够简单
 *
 * 如果 `.env` 不存在，这里会静默跳过，不会报错。
 */
async function loadProjectEnvFile(): Promise<void> {
  const envFilePath = path.join(PROJECT_ROOT, ".env");

  try {
    const raw = await readFile(envFilePath, "utf8");
    applyEnvContent(raw);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;

    if (code !== "ENOENT") {
      throw new Error(`读取 .env 文件失败: ${envFilePath}`);
    }
  }
}

/**
 * 把 `.env` 文本内容解析到 `process.env`。
 *
 * 规则故意保持简单：
 * - 支持空行
 * - 支持 `#` 注释
 * - 支持 `KEY=value`
 * - 支持简单的单引号 / 双引号包裹
 *
 * 这里采用"项目内配置覆盖当前 shell 同名变量"的策略，
 * 目的是让这个 demo 的本地配置优先生效，避免再次被终端里残留的旧变量污染。
 */
function applyEnvContent(raw: string): void {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();

    if (!key) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(value);
  }
}

// `.env` 里常见写法是 `KEY="value"` 或 `KEY='value'`。
// 这里把最外层引号去掉，保留真正的值。
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * 确认目标路径存在且是 Git 仓库。
 *
 * 这里先检查"路径是否存在"，再检查"是不是 git 仓库"，
 * 是为了给用户更具体的错误提示，而不是把两类问题混成一种。
 */
async function ensureGitRepo(repoPath: string): Promise<string> {
  try {
    await access(repoPath);
  } catch {
    throw new Error(`目标路径不存在: ${repoPath}`);
  }

  try {
    // `git rev-parse --show-toplevel` 是一个很适合做仓库校验的命令：
    // - 如果当前目录是 git 仓库，会返回仓库根目录
    // - 如果不是 git 仓库，会直接报错
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath,
    });

    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`目标路径不是可用的 Git 仓库: ${repoPath}\n${message}`);
  }
}

/**
 * 根据可选的项目关键词解析真正要分析的仓库路径。
 *
 * 规则很简单：
 * - 不传关键词：继续使用默认仓库
 * - 传关键词：在 `/Users/sunzhennan/Desktop/Code` 一级目录里找 Git 仓库
 * - 只有一个最高优先候选：自动选中
 * - 多个最高优先候选：TTY 下交互选择，非 TTY 下列出候选并退出
 */
async function resolveRepoPath(repoKeyword?: string): Promise<string> {
  if (!repoKeyword) {
    return DEFAULT_REPO_PATH;
  }

  const discoveredRepos = await discoverGitRepos(DEFAULT_REPO_SEARCH_ROOT);
  const matches = matchRepos(discoveredRepos, repoKeyword);

  if (matches.length === 0) {
    throw new Error(
      [
        `未找到匹配仓库: ${repoKeyword}`,
        `搜索范围: ${DEFAULT_REPO_SEARCH_ROOT}`,
        "请换一个更准确的项目关键词，例如：--repo=weass-b-mono",
      ].join("\n"),
    );
  }

  const bestMatchLevel = matches[0]?.matchLevel ?? 0;
  const bestMatches = matches.filter(match => match.matchLevel === bestMatchLevel);
  const bestMatch = bestMatches[0];

  if (bestMatches.length === 1 && bestMatch) {
    return bestMatch.path;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(buildRepoConflictMessage(repoKeyword, matches));
  }

  return promptRepoSelection(repoKeyword, matches);
}

// 显式 `--repo=<关键词>` 仍然走本地模糊匹配。
// 这里优先扫描一级子目录；如果一级没有任何 Git 仓库，再向下一层扩一层。
async function discoverGitRepos(searchRoot: string): Promise<DiscoveredRepo[]> {
  const entries = await readdir(searchRoot, { withFileTypes: true });
  const topLevelDirectories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(searchRoot, entry.name));

  // 先只看一级目录。
  // 这是最符合当前使用习惯的，也能避免一上来把搜索范围扩太散。
  let repositories = await filterGitRepos(topLevelDirectories);
  if (repositories.length > 0) {
    return repositories;
  }

  // 如果一级目录一个仓库都没找到，再保守地向下一层扩一层。
  // 这里故意不做无限递归，否则结果会越来越不可控，也更难解释给小白。
  const secondLevelEntries = await Promise.all(
    topLevelDirectories.map(async parentPath => {
      try {
        const childEntries = await readdir(parentPath, { withFileTypes: true });
        return childEntries
          .filter(entry => entry.isDirectory())
          .map(entry => path.join(parentPath, entry.name));
      } catch {
        return [];
      }
    }),
  );

  repositories = await filterGitRepos(secondLevelEntries.flat());
  return repositories;
}

async function filterGitRepos(candidatePaths: string[]): Promise<DiscoveredRepo[]> {
  // 这里的职责很单纯：把"候选目录列表"过滤成"真实 Git 仓库列表"。
  const results = await Promise.all(
    candidatePaths.map(async candidatePath => {
      try {
        const repoPath = await ensureGitRepo(candidatePath);
        return {
          name: path.basename(repoPath),
          path: repoPath,
        };
      } catch {
        return undefined;
      }
    }),
  );

  return results.filter((repo): repo is DiscoveredRepo => Boolean(repo));
}

// 当前 demo 的模糊匹配故意保持简单：
// exact > startsWith > contains，避免为了"更聪明"反而让结果不可预测。
function matchRepos(repos: DiscoveredRepo[], repoKeyword: string): RepoMatch[] {
  const normalizedKeyword = repoKeyword.trim().toLowerCase();

  return repos
    .map(repo => {
      const normalizedName = repo.name.toLowerCase();
      let matchLevel = 0;

      if (normalizedName === normalizedKeyword) {
        matchLevel = 3;
      } else if (normalizedName.startsWith(normalizedKeyword)) {
        matchLevel = 2;
      } else if (normalizedName.includes(normalizedKeyword)) {
        matchLevel = 1;
      }

      return matchLevel > 0 ? { ...repo, matchLevel } : undefined;
    })
    .filter((repo): repo is RepoMatch => Boolean(repo))
    .sort((left, right) => {
      if (right.matchLevel !== left.matchLevel) {
        return right.matchLevel - left.matchLevel;
      }

      if (left.name.length !== right.name.length) {
        return left.name.length - right.name.length;
      }

      return left.name.localeCompare(right.name);
    });
}

// 多个最优候选时，终端交互让用户自己选，比"猜一个"更稳。
async function promptRepoSelection(repoKeyword: string, matches: RepoMatch[]): Promise<string> {
  console.log(buildRepoConflictMessage(repoKeyword, matches));

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await readline.question("请输入序号选择仓库，或输入 q 退出: ")).trim();

      if (answer.toLowerCase() === "q") {
        throw new Error("已取消仓库选择。");
      }

      const selectedIndex = Number.parseInt(answer, 10);
      if (Number.isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > matches.length) {
        console.log("输入无效，请重新输入。");
        continue;
      }

      const selectedMatch = matches[selectedIndex - 1];
      if (!selectedMatch) {
        console.log("输入无效，请重新输入。");
        continue;
      }

      return selectedMatch.path;
    }
  } finally {
    readline.close();
  }
}

function buildRepoConflictMessage(repoKeyword: string, matches: RepoMatch[]): string {
  return [
    `关键词 "${repoKeyword}" 匹配到多个仓库，请选择：`,
    ...matches.map((match, index) => `${index + 1}. ${match.name}`),
  ].join("\n");
}

// 报告文件名带上项目名和时间范围，避免不同项目同一天覆盖同一个文件。
function buildReportFileName(repoPath: string, since: string, until: string): string {
  const repoName = sanitizeFileNamePart(path.basename(repoPath));
  const sinceDate = since.slice(0, 10);
  const untilDate = until.slice(0, 10);

  return `weekly-summary-${repoName}-${sinceDate}-to-${untilDate}.md`;
}

function sanitizeFileNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * 解析 CLI 参数。
 *
 * 这里不用额外引入 commander / yargs 一类库，是因为当前 demo 的参数面非常小：
 * 只支持 `--repo=`、`--since=`、`--until=`、`--help` 四类输入。
 * 自己写一份简单解析，反而更容易给小白讲清楚。
 */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };

  for (const current of argv) {
    if (!current) {
      continue;
    }

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (current === "--repo") {
      throw new Error("参数 `--repo` 只支持 `--repo=<关键词>` 写法。");
    }

    if (current === "--since") {
      throw new Error("参数 `--since` 只支持 `--since=<时间>` 写法。");
    }

    if (current === "--until") {
      throw new Error("参数 `--until` 只支持 `--until=<时间>` 写法。");
    }

    if (current.startsWith("--repo=")) {
      args.repoArg = getEqualsArgValue(current, "--repo");
      continue;
    }

    // 只支持 `--since=2026-03-30` 这种写法。
    if (current.startsWith("--since=")) {
      args.sinceArg = getEqualsArgValue(current, "--since");
      continue;
    }

    // 与 `since` 相同，`until` 也统一收紧成 `--until=<时间>`。
    if (current.startsWith("--until=")) {
      args.untilArg = getEqualsArgValue(current, "--until");
      continue;
    }

    throw new Error(`不支持的参数: ${current}`);
  }

  return args;
}

function getEqualsArgValue(current: string, flag: "--repo" | "--since" | "--until"): string {
  const prefix = `${flag}=`;
  const value = current.slice(prefix.length).trim();

  if (!value) {
    throw new Error(`参数 \`${flag}\` 缺少值，请使用 \`${flag}=...\`。`);
  }

  return value;
}

/**
 * 打印帮助信息。
 *
 * 帮助信息也故意只保留当前 demo 真正需要的配置项，
 * 避免为了历史兼容把说明写复杂。
 */
function printHelp(): void {
  console.log(
    [
      "Claude Agent SDK 周报 Demo",
      "",
      "用法:",
      "  npm run report",
      "  npm run report -- --repo=weass-b",
      "  npm run report -- --since=2026-03-30",
      "  npm run report -- --since=2026-03-30 --until=2026-04-01",
      "  npm run report -- --repo=weass-b --since=2026-03-30 --until=2026-04-01",
      "",
      "参数:",
      "  --repo=<关键词>   可选，按项目名模糊匹配仓库",
      "  --since=<时间>    可选，覆盖起始时间",
      "  --until=<时间>    可选，覆盖结束时间",
      "",
      "环境变量:",
      "  KIMI_API_KEY  必填，Kimi Coding Plan API Key",
      "  KIMI_MODEL    可选，默认 kimi-for-coding",
      "",
      "注意:",
      "  Claude Agent SDK 要求 Node 18+。",
      "  不传 --repo 或完全不传时间时，会进入一句话输入模式，由 resolver agent 解析仓库和时间。",
      "  resolver 仓库搜索范围固定为 /Users/sunzhennan/Desktop/Code，优先一级目录，必要时再向下一层扩一层。",
      "  所有参数只支持 --key=value 写法。",
    ].join("\n"),
  );
}

// 所有未捕获错误最终都统一落到这里，保证 CLI 输出是单行、直观、可读的。
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
