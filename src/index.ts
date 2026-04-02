import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { resolveDateRange } from "./dateRange.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

// `execFile` 比 `exec` 更适合这里：
// 1. 我们只是调用一个固定命令 `git`
// 2. 不需要 shell 解释，安全性更高
// 3. 参数数组传递更清晰，不容易被空格或特殊字符干扰
const execFile = promisify(execFileCallback);

// 当前 demo 默认分析一个本地仓库，同时允许通过 `--repo=<关键词>` 切换项目。
const DEFAULT_REPO_PATH = "/Users/sunzhennan/Desktop/Code/weass-b-mono";
// 自定义项目搜索范围固定在 Code 一级目录，避免递归搜索把结果变得太乱。
const DEFAULT_REPO_SEARCH_ROOT = "/Users/sunzhennan/Desktop/Code";
// 这里强制固定为百炼的 Anthropic 兼容网关，避免用户终端里残留别家网关变量。
const DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/apps/anthropic";
// 默认模型也固定给一个可直接跑通的值，减少第一次使用时的决策成本。
const DEFAULT_BAILIAN_MODEL = "qwen3.5-plus";
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

/**
 * 整个 CLI 的主流程。
 *
 * 这一个函数把“从命令到报告”的链路串起来：
 * 1. 解析参数
 * 2. 准备百炼/SDK 运行环境
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

  // 不传 `--repo` 时继续分析默认仓库；
  // 传了 `--repo=<关键词>` 时，先在固定目录里做一级模糊匹配，再解析成真实仓库路径。
  const resolvedRepoPath = await resolveRepoPath(cliArgs.repoArg);
  const verifiedRepoPath = await ensureGitRepo(resolvedRepoPath);

  // 时间范围既支持默认“本周”，也支持手动覆盖，细节都收敛在 `dateRange.ts` 里。
  const dateRange = resolveDateRange({
    sinceArg: cliArgs.sinceArg,
    untilArg: cliArgs.untilArg,
  });

  // 这些启动信息是特意打印给“演示场景”看的：
  // - 你可以现场确认正在分析哪个仓库
  // - 你可以说明当前用的是百炼哪个模型
  // - 你可以证明程序确实被锁定到了百炼网关
  console.log(`目标仓库: ${verifiedRepoPath}`);
  console.log(`分析范围: ${dateRange.humanRange}`);
  console.log(`模型网关: ${runtimeConfig.baseUrl}`);
  console.log(`模型名称: ${runtimeConfig.model}`);
  console.log("正在调用 Claude Code SDK 分析提交...\n");

  // 这里真正进入 Agent 阶段。
  // 进入后，主程序自己不再手写 `git log` / `git show` 的业务逻辑，
  // 而是把任务和约束交给 Claude Agent SDK。
  const report = await runWeeklyReportAgent({
    repoPath: verifiedRepoPath,
    since: dateRange.since,
    until: dateRange.until,
    humanRange: dateRange.humanRange,
    model: runtimeConfig.model,
  });

  // `reports/` 目录可能还不存在，所以先确保目录存在再写文件。
  await mkdir(REPORTS_DIR, { recursive: true });
  const outputPath = path.join(
    REPORTS_DIR,
    buildReportFileName(verifiedRepoPath, dateRange.since, dateRange.until),
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
 * 调用 Claude Agent SDK 执行一次“本周提交分析”任务。
 *
 * 这里的思路不是“我自己写 git 命令并自己总结”，而是：
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
      // 当前 demo 只做读仓库 + 生成报告，不涉及主动改代码。
      // 这里保留 `acceptEdits` 是为了使用 SDK 的标准非交互模式；
      // 真正的安全边界主要由 `allowedTools` 控制。
      permissionMode: "acceptEdits",
      // 只开放 `git` 相关 bash 命令和文件读取能力。
      // 这是故意缩小工具面，保证 demo 的可控性和可解释性。
      allowedTools: ["Bash(git:*)", "Read"],
      // system prompt 负责“长期规则”，user prompt 负责“这次任务输入”。
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
 * 1. 只读取当前 demo 约定的 `BAILIAN_API_KEY`
 * 2. 强制把 Anthropic 兼容网关锁死到百炼，避免被其他环境变量污染
 *
 * 这是当前项目“能稳定跑在百炼上”的核心。
 */
function prepareRuntimeConfig(): { baseUrl: string; model: string } {
  // 当前 demo 只认一个对使用者最直观的变量名：`BAILIAN_API_KEY`。
  // 找到以后，再由程序内部映射成 SDK 习惯读取的 Anthropic 变量名。
  const bailianApiKey = process.env.BAILIAN_API_KEY?.trim();

  if (!bailianApiKey) {
    throw new Error(
      [
        "缺少 API Key。",
        "这个 demo 现在默认走百炼 Anthropic 兼容接口。",
        "请至少设置以下环境变量后再运行：BAILIAN_API_KEY。",
      ].join(" "),
    );
  }

  // Normalize credentials so stale third-party Anthropic-compatible tokens
  // cannot hijack requests after we force the Bailian gateway.
  //
  // 这里同时设置两个变量，是为了兼容不同 Anthropic 兼容实现可能读取的字段。
  process.env.ANTHROPIC_API_KEY = bailianApiKey;
  process.env.ANTHROPIC_AUTH_TOKEN = bailianApiKey;

  // Force the SDK onto Bailian's Anthropic-compatible gateway so stray
  // environment variables from other vendors do not hijack the runtime.
  process.env.ANTHROPIC_BASE_URL = DEFAULT_BAILIAN_BASE_URL;

  // 模型只认我们自己定义的 `BAILIAN_MODEL`，这样语义更清楚，也不容易跟别家环境变量混淆。
  const model = process.env.BAILIAN_MODEL?.trim() || DEFAULT_BAILIAN_MODEL;

  return {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  };
}

/**
 * 检查当前 Node 版本是否满足 Claude Agent SDK 的最低要求。
 *
 * 这一步放在最前面，是为了把“环境问题”和“业务逻辑问题”区分开：
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
 * 这里采用“项目内配置覆盖当前 shell 同名变量”的策略，
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
 * 这里先检查“路径是否存在”，再检查“是不是 git 仓库”，
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

// 只扫描一级子目录，并过滤出真正可用的 Git 仓库。
async function discoverGitRepos(searchRoot: string): Promise<DiscoveredRepo[]> {
  const entries = await readdir(searchRoot, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(searchRoot, entry.name));

  const results = await Promise.all(
    directories.map(async candidatePath => {
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
// exact > startsWith > contains，避免为了“更聪明”反而让结果不可预测。
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

// 多个最优候选时，终端交互让用户自己选，比“猜一个”更稳。
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
      "  npm run report -- --since=2026-03-30 --until=2026-04-01",
      "  npm run report -- --repo=weass-b --since=2026-03-30 --until=2026-04-01",
      "",
      "参数:",
      "  --repo=<关键词>   可选，按项目名模糊匹配仓库",
      "  --since=<时间>    可选，覆盖起始时间",
      "  --until=<时间>    可选，覆盖结束时间",
      "",
      "环境变量:",
      "  BAILIAN_API_KEY  必填，百炼 API Key",
      "  BAILIAN_MODEL    可选，默认 qwen3.5-plus",
      "",
      "注意:",
      "  Claude Agent SDK 要求 Node 18+。",
      "  仓库搜索范围固定为 /Users/sunzhennan/Desktop/Code 一级目录。",
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
