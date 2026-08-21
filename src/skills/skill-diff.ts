import { parseSkillMarkdown } from "./skill-markdown.js";

/**
 * Skill 版本语义化差异（Task 13）。
 *
 * 目标不是逐字符 diff，而是让审核者在 Verify 之前回答一个问题：
 * "这版 Draft 和已发布版本相比，语义上改了什么？"
 * 输出按 frontmatter 字段和正文章节两个层面组织，每次变更附行级增删。
 */

export interface SkillDiffEntry {
  /** 变更层面：field = frontmatter 字段；section = 正文二级章节。 */
  kind: "field" | "section";
  /** added / removed / modified。 */
  change: "added" | "removed" | "modified";
  /** 字段名或章节标题。 */
  target: string;
  /** 变更前的值（field 为字符串值；section 为章节正文）。 */
  before?: string;
  /** 变更后的值。 */
  after?: string;
  /** modified 章节的行级新增（相对 before）。 */
  addedLines?: string[];
  /** modified 章节的行级删除（相对 before）。 */
  removedLines?: string[];
}

export interface SkillDiffResult {
  /** 对照的旧版本号；当前是首个版本且无历史可比时为 null。 */
  fromVersion: number | null;
  /** 当前版本号。 */
  toVersion: number;
  entries: SkillDiffEntry[];
  /** 中文摘要（一句话），供列表与通知直接展示。 */
  summary: string;
}

/** 计算两份 SKILL.md 的语义化差异。fromLabel/toLabel 用于错误信息，不影响结果。 */
export function diffSkillMarkdown(
  fromContent: string,
  toContent: string,
  fromVersion: number | null,
  toVersion: number,
): SkillDiffResult {
  const from = parseSkillMarkdown(fromContent);
  const to = parseSkillMarkdown(toContent);
  const entries: SkillDiffEntry[] = [];

  // frontmatter 字段层：按字段名并集比较
  const fromFields = scalarFields(from.frontmatter);
  const toFields = scalarFields(to.frontmatter);
  for (const key of [...new Set([...Object.keys(fromFields), ...Object.keys(toFields)])].sort()) {
    const before = fromFields[key];
    const after = toFields[key];
    if (before !== undefined && after === undefined) {
      entries.push({ kind: "field", change: "removed", target: key, before });
      continue;
    }
    if (before === undefined && after !== undefined) {
      entries.push({ kind: "field", change: "added", target: key, after });
      continue;
    }
    if (before !== undefined && after !== undefined && before !== after) {
      entries.push({ kind: "field", change: "modified", target: key, before, after });
    }
  }

  // 正文章节层：按归一化标题匹配，未匹配的即新增/删除
  const fromSections = new Map(from.sections.map((section) => [section.normalizedTitle, section]));
  const toSections = new Map(to.sections.map((section) => [section.normalizedTitle, section]));
  const orderedTitles = [
    ...from.sections.map((section) => section.normalizedTitle),
    ...to.sections.map((section) => section.normalizedTitle),
  ];
  for (const title of [...new Set(orderedTitles)]) {
    const before = fromSections.get(title);
    const after = toSections.get(title);
    if (before && !after) {
      entries.push({ kind: "section", change: "removed", target: before.title, before: before.body });
      continue;
    }
    if (!before && after) {
      entries.push({ kind: "section", change: "added", target: after.title, after: after.body });
      continue;
    }
    if (before && after && before.body !== after.body) {
      const { added, removed } = diffLines(before.body.split("\n"), after.body.split("\n"));
      entries.push({
        kind: "section",
        change: "modified",
        target: after.title,
        before: before.body,
        after: after.body,
        addedLines: added,
        removedLines: removed,
      });
    }
  }

  return {
    fromVersion,
    toVersion,
    entries,
    summary: summarize(entries),
  };
}

/** 空差异时的语义：内容完全一致，无需重新审核语义。 */
export function emptySkillDiff(fromVersion: number | null, toVersion: number): SkillDiffResult {
  return {
    fromVersion,
    toVersion,
    entries: [],
    summary: fromVersion === null ? "首个版本，没有可比较的历史版本" : "与对照版本内容一致",
  };
}

function summarize(entries: readonly SkillDiffEntry[]): string {
  if (entries.length === 0) return "内容一致";
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "field") {
      parts.push(`字段「${entry.target}」${changeLabel(entry.change)}`);
      continue;
    }
    if (entry.change === "modified") {
      parts.push(`章节「${entry.target}」改动 ${entry.addedLines?.length ?? 0} 增 / ${entry.removedLines?.length ?? 0} 删`);
      continue;
    }
    parts.push(`章节「${entry.target}」${changeLabel(entry.change)}`);
  }
  return parts.join("；");
}

function changeLabel(change: SkillDiffEntry["change"]): string {
  if (change === "added") return "新增";
  if (change === "removed") return "删除";
  return "修改";
}

/** 只比较字符串标量字段；数组/嵌套结构序列化成字符串参与比较。 */
function scalarFields(frontmatter: Record<string, unknown> | null): Record<string, string> {
  if (!frontmatter) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue;
    fields[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return fields;
}

/** 行级差异：经典 LCS 最长公共子序列，章节行数很小，O(n·m) 足够。 */
function diffLines(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(before[i]!);
      i += 1;
    } else {
      added.push(after[j]!);
      j += 1;
    }
  }
  while (i < rows) {
    removed.push(before[i]!);
    i += 1;
  }
  while (j < cols) {
    added.push(after[j]!);
    j += 1;
  }
  return { added, removed };
}
