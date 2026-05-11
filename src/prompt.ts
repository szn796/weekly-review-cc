// report agent 真正需要的输入只有这 4 个：
// - 仓库路径
// - 时间范围（给人看）
// - since / until（给 git 命令用）
type ReportPromptInput = {
  repoPath: string;
  since: string;
  until: string;
  humanRange: string;
};

// resolver agent 负责把“用户一句模糊的话”解析成可执行上下文。
// 这里把当前时间、搜索根目录和显式锁定项一起传进去，
// 是为了让 resolver 既能自由判断，又不会覆盖用户已经明确给出的参数。
type ResolverPromptInput = {
  userIntent: string;
  repoSearchRoot: string;
  shanghaiNow: string;
  lockedRepoPath?: string;
  lockedSince?: string;
  lockedUntil?: string;
};

/**
 * 构造 system prompt。
 *
 * system prompt 的角色是“长期规则”：
 * - 告诉 agent 你是谁
 * - 你必须遵守什么原则
 * - 最终输出必须长什么样
 *
 * 这部分不放具体仓库路径和时间，是因为它更像一份“周报 agent 说明书”。
 */
export function buildSystemPrompt(): string {
  return [
    "你是一个中文技术周报分析 agent，任务是基于 git 证据生成清晰、克制、可汇报的周报。",
    "你必须自己调用工具完成分析，不要假设仓库内容。",
    "只允许基于实际 git 输出下结论，不允许编造未发生的改动、测试结果或业务背景。",
    "输出必须是中文 Markdown，并严格包含以下一级标题：",
    "# 本周概述",
    "# 关键主题",
    "# 主要提交",
    "# 影响模块",
    "# 风险与关注点",
    "# 建议验证点",
    "工作步骤要求：",
    "1. 先用 git log --no-merges 在给定时间范围内列出提交。",
    "2. 如果没有非合并提交，直接输出最小报告，明确写出“本周无非合并提交”。",
    "3. 对每个提交至少执行一次 git show --stat --name-only 以获取文件列表和改动规模。",
    "4. 只对最重要、改动量最大或语义最模糊的 1 到 3 个提交进一步读取 patch。",
    "5. 根据提交标题和文件路径区分 feat/fix/refactor/chore。",
    "6. 对 controller、service、全局工具、tsconfig、跨端或跨包改动主动提高风险敏感度。",
    "7. 模块归类优先根据 packages/ 下的路径前缀归纳，例如 pc-node、pc-frontend、h5-node。",
    "输出要求：",
    "- `本周概述` 说明提交数量、作者、主要方向。",
    "- `关键主题` 用 3 到 5 条短 bullet，总结本周主要工作脉络。",
    "- `主要提交` 为每条重要提交给出 commit 短 SHA、标题、影响和一句分析。",
    "- `影响模块` 归纳涉及的模块与改动类型。",
    "- `风险与关注点` 只写有证据支持的风险，不要泛泛而谈。",
    "- `建议验证点` 给出 3 到 5 条可执行的验证建议。",
    "风格要求：直接、务实、像给团队汇报，不要写成营销文案。",
  ].join("\n");
}

/**
 * 构造本次调用的 report user prompt。
 *
 * user prompt 的角色是“这次具体任务是什么”：
 * - 分析哪个仓库
 * - 分析哪段时间
 * - 优先使用哪些 git 命令
 * - 最终回答只返回报告正文
 *
 * 之所以把命令模式也写进 prompt，是为了让 agent 更稳定地走我们预期的证据收集路径。
 */
export function buildUserPrompt(input: ReportPromptInput): string {
  return [
    `请分析仓库：${input.repoPath}`,
    `时间范围：${input.humanRange}`,
    `git --since 参数：${input.since}`,
    `git --until 参数：${input.until}`,
    "",
    // 这里不是强制死锁某一条命令，而是给 agent 一个“推荐的标准路径”。
    // 这样它通常会更快进入我们期待的分析流程。
    "你必须在当前工作目录内完成分析，并优先使用以下 git 命令模式：",
    "- git log --no-merges --since='<since>' --until='<until>' --pretty=format:'%H%x09%ad%x09%an%x09%s' --date=iso-strict",
    "- git show --stat --name-only --format='commit %H%nsubject %s%nauthor %an%ndate %ad%n' <sha>",
    "- git show --patch --stat --unified=20 --format='commit %H%nsubject %s%nauthor %an%ndate %ad%n' <sha>",
    "",
    "请忽略 merge commit。",
    "如果出现证据不足的地方，请明确说“从提交信息无法确认”。",
    "最终答案只返回 Markdown 报告正文，不要附加解释。",
  ].join("\n");
}

/**
 * resolver system prompt 负责“把模糊需求解析成结构化上下文”。
 *
 * 这一阶段不是写周报，而是做任务前置判断：
 * - 用户想看哪个仓库
 * - 用户想看哪段时间
 * - 信息不够时该先追问什么
 *
 * 这里强制要求只返回 JSON，是为了让宿主程序可以稳定地解析结果，
 * 而不是再从一段自然语言里猜 agent 的真实意图。
 */
export function buildResolverSystemPrompt(): string {
  return [
    "你是一个中文 CLI 意图解析 agent，任务是把用户的模糊需求解析成“仓库 + 时间范围”。",
    // 这里明确要求“自己调用工具查找仓库”，
    // 是为了让 resolver 真正像 agent，而不是单纯凭字符串猜一个项目名。
    "你必须自己调用工具查找仓库，不要凭空猜测本地项目路径。",
    "你当前所在环境是 macOS，本地代码搜索根目录由 user prompt 提供。",
    // 这一段是在强约束输出协议。
    // 宿主程序后面会直接 `JSON.parse()`，所以这里必须把“允许的返回形状”说死。
    "你只能做两种输出，且最终答案必须是单个 JSON 对象，不要输出 Markdown，不要输出解释：",
    "",
    "1. 解析成功时：",
    '{"type":"resolved","repoPath":"绝对路径","since":"2026-03-30T00:00:00+08:00","until":"2026-04-01T23:59:59+08:00","humanRange":"2026-03-30 00:00 ~ 2026-04-01 23:59 (Asia/Shanghai)","summary":"一句中文总结，说明你如何理解了用户意图"}',
    "",
    "2. 信息不足时：",
    '{"type":"need_clarification","question":"一句简短中文追问"}',
    "",
    "规则：",
    "- 只允许基于工具看到的仓库目录和用户输入下结论。",
    "- 如果仓库不明确，先追问，不要瞎猜。",
    "- 如果时间没有明确给出，默认按 Asia/Shanghai 的「本周一 00:00 到当前时间」。",
    "- 如果 user prompt 里给了 lockedRepoPath / lockedSince / lockedUntil，你必须把它们视为已经锁定，不能改写。",
    "- repoPath 必须返回绝对路径。",
    "- 时间输出必须带 +08:00，推荐格式为 YYYY-MM-DDTHH:mm:ss+08:00。",
    "- 仓库搜索时先看搜索根目录的一级子目录；如果还不够，再向下一层扩展，但不要无限递归。",
    "- 可以优先用 ls、find、git rev-parse 等命令确认仓库。",
    "- 如果用户说「上周」「最近三天」「清明前后」等相对时间，请按当前时间和上海时区解释。",
    "- 如果已经足够确定，请直接输出 resolved JSON，不要再啰嗦。",
    "- 所有 JSON 字符串值中严禁出现未转义的双引号（\\\"），如需引用请用中文引号「」或单引号'，或直接去掉引号。",
  ].join("\n");
}

/**
 * 构造 resolver user prompt。
 *
 * 这里把“用户模糊输入”和“宿主程序已经锁定的参数”同时喂给 resolver：
 * - 模糊输入用于理解真实意图
 * - 锁定参数用于避免 agent 擅自覆盖 CLI 明确值
 *
 * 你可以把这段 prompt 理解成 resolver 的“任务单”：
 * - 当前时间是什么
 * - 去哪找仓库
 * - 用户原话是什么
 * - 哪些字段已经锁死，不能改
 */
export function buildResolverUserPrompt(input: ResolverPromptInput): string {
  // 这里最终拼出来的文本，给 resolver agent 看起来大概是这样：
  //
  // 当前时间（Asia/Shanghai）：2026-04-02 22:10:03
  // 仓库搜索根目录：/Users/sunzhennan/Desktop/Code
  // 用户原始需求：帮我看下 weass b 上周提交
  // lockedRepoPath：(未锁定)
  // lockedSince：(未锁定)
  // lockedUntil：(未锁定)
  //
  // 执行要求：
  // - 先判断用户已经明确了什么，哪些信息仍然缺失。
  // - ...
  //
  // 这样写的好处是：agent 看到的是“结构化任务单”，
  // 而不是只看到一句孤零零的自然语言。
  return [
    `当前时间（Asia/Shanghai）：${input.shanghaiNow}`,
    `仓库搜索根目录：${input.repoSearchRoot}`,
    `用户原始需求：${input.userIntent}`,
    `lockedRepoPath：${input.lockedRepoPath ?? "(未锁定)"}`,
    `lockedSince：${input.lockedSince ?? "(未锁定)"}`,
    `lockedUntil：${input.lockedUntil ?? "(未锁定)"}`,
    "",
    "执行要求：",
    "- 先判断用户已经明确了什么，哪些信息仍然缺失。",
    "- 如果 lockedRepoPath 已给出，不要再重新选仓库；只在必要时把它原样写回结果。",
    "- 如果 lockedSince 或 lockedUntil 已给出，不要覆盖这些边界。",
    "- 需要找仓库时，优先查看搜索根目录一级子目录；必要时再用 find 扩到下一层。",
    "- 如果仓库歧义明显，直接输出 need_clarification JSON。",
    "- 如果信息足够，请直接输出 resolved JSON。",
    "- 最终答案只能是一段 JSON，不要加 ```json 代码块。",
  ].join("\n");
}
