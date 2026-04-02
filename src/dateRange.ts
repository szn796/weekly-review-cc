// 当前 demo 统一按上海时区理解“本周”。
// 因为分享场景和团队习惯都基于国内时区，所以这里直接写死 +08:00。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 统一的时间范围结构：
// - since / until：适合给 git 命令直接使用
// - reportDate：适合作为报告文件名的一部分
// - humanRange：适合打印给人看
export type DateRange = {
  since: string;
  until: string;
  reportDate: string;
  humanRange: string;
};

// 外部可选传入的时间覆盖参数。
// 如果不传，就走“本周一到现在”的默认逻辑。
type RangeOverrides = {
  sinceArg?: string;
  untilArg?: string;
};

/**
 * 解析最终要使用的时间范围。
 *
 * 这个函数的角色可以理解成“总调度”：
 * 1. 先算出默认周范围
 * 2. 再看用户有没有手动覆盖
 * 3. 最后统一转换成 git 和展示都能直接使用的格式
 */
export function resolveDateRange(overrides: RangeOverrides, now = new Date()): DateRange {
  const defaultRange = buildWeeklyDateRange(now);

  // 如果用户传了参数，就尊重用户输入；
  // 否则就用默认的“本周一 00:00 到现在”。
  const sinceDate = overrides.sinceArg
    ? parseUserDateInput(overrides.sinceArg, false)
    : new Date(defaultRange.since);
  const untilDate = overrides.untilArg
    ? parseUserDateInput(overrides.untilArg, true)
    : new Date(defaultRange.until);

  if (sinceDate.getTime() > untilDate.getTime()) {
    throw new Error("`--since` 不能晚于 `--until`。");
  }

  return {
    since: formatShanghaiIso(sinceDate),
    until: formatShanghaiIso(untilDate),
    reportDate: getShanghaiDateLabel(untilDate),
    // humanRange 只用于人类阅读，所以格式尽量简洁。
    humanRange: `${formatShanghaiHuman(sinceDate)} ~ ${formatShanghaiHuman(untilDate)} (Asia/Shanghai)`,
  };
}

/**
 * 计算“默认本周范围”。
 *
 * 这里要特别注意：JavaScript 原生 `Date` 默认更偏向本地/UTC 混合语义，
 * 直接算周一很容易把时区弄乱。
 *
 * 这里的做法是：
 * 1. 先把当前时间平移到“上海时区视角”
 * 2. 在这个视角里计算本周一 00:00
 * 3. 再平移回真实 UTC 时间点
 *
 * 这样最终得到的 since/until 才会稳定地落在上海时区语义下。
 */
export function buildWeeklyDateRange(now = new Date()): DateRange {
  const shanghaiPseudoUtc = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  // JS 里 Sunday = 0，这里把它转成 7，便于统一按“周一是 1”来算。
  const weekday = shanghaiPseudoUtc.getUTCDay() || 7;
  const mondayPseudoUtcMs = Date.UTC(
    shanghaiPseudoUtc.getUTCFullYear(),
    shanghaiPseudoUtc.getUTCMonth(),
    shanghaiPseudoUtc.getUTCDate() - (weekday - 1),
    0,
    0,
    0,
    0,
  );
  const mondayUtc = new Date(mondayPseudoUtcMs - SHANGHAI_OFFSET_MS);

  return {
    since: formatShanghaiIso(mondayUtc),
    until: formatShanghaiIso(now),
    reportDate: getShanghaiDateLabel(now),
    humanRange: `${formatShanghaiHuman(mondayUtc)} ~ ${formatShanghaiHuman(now)} (Asia/Shanghai)`,
  };
}

/**
 * 解析用户传进来的时间字符串。
 *
 * 支持这几类：
 * - YYYY-MM-DD
 * - YYYY-MM-DD HH:mm
 * - YYYY-MM-DD HH:mm:ss
 * - 标准 ISO
 *
 * 其中前 3 类如果没有显式时区，一律按 +08:00 理解。
 */
function parseUserDateInput(raw: string, endOfRange: boolean): Date {
  const value = raw.trim();

  // 只有日期，没有时间时：
  // - since 默认补到当天 00:00:00
  // - until 默认补到当天 23:59:59
  const dateOnlyMatch = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (dateOnlyMatch) {
    return parseStrictDate(`${value}T${endOfRange ? "23:59:59" : "00:00:00"}+08:00`, raw);
  }

  // 本地日期时间格式如果不带秒，自动补 `:00`。
  const localDateTimeMatch = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.exec(value);
  if (localDateTimeMatch) {
    const normalized = value.replace(" ", "T");
    const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
    return parseStrictDate(`${withSeconds}+08:00`, raw);
  }

  return parseStrictDate(value, raw);
}

// 用统一函数兜底时间解析，并在失败时抛出更可读的错误。
function parseStrictDate(value: string, rawInput: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法解析时间参数: ${rawInput}`);
  }
  return date;
}

// 统一格式化成带 +08:00 的 ISO 字符串，方便直接传给 git `--since/--until`。
function formatShanghaiIso(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  const second = pad2(shifted.getUTCSeconds());

  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

// 人类可读版本，不需要秒，适合控制台打印和展示。
function formatShanghaiHuman(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// 文件名只需要“日期”这一层，所以单独提供一个标签格式。
function getShanghaiDateLabel(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());

  return `${year}-${month}-${day}`;
}

// 常见的两位补零工具函数。
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
