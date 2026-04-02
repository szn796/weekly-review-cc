// 当前任务里，user prompt 真正需要的输入只有这 4 个：
// - 仓库路径
// - 时间范围（给人看）
// - since / until（给 git 命令用）
type PromptInput = {
  repoPath: string;
  since: string;
  until: string;
  humanRange: string;
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
 * 构造本次调用的 user prompt。
 *
 * user prompt 的角色是“这次具体任务是什么”：
 * - 分析哪个仓库
 * - 分析哪段时间
 * - 优先使用哪些 git 命令
 * - 最终回答只返回报告正文
 *
 * 之所以把命令模式也写进 prompt，是为了让 agent 更稳定地走我们预期的证据收集路径。
 */
export function buildUserPrompt(input: PromptInput): string {
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
