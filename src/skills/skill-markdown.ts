import { parseDocument } from "yaml";

/**
 * SKILL.md 结构解析：把"frontmatter + 正文二级章节"的通用结构
 * 抽成一处，供质量校验器（skill-validator）与语义化差异（skill-diff）共用，
 * 避免两套解析规则随时间漂移。
 */

export interface SkillMarkdownSection {
  /** 章节标题原文（去掉 `## ` 前缀后的整行，保留大小写便于展示）。 */
  title: string;
  /** 标题归一化形式（小写去空白），用于中英文别名匹配。 */
  normalizedTitle: string;
  /** 章节正文（不含标题行）。 */
  body: string;
}

export interface ParsedSkillMarkdown {
  /** frontmatter 原文（不含 --- 分隔线）；没有 frontmatter 时为 null。 */
  frontmatterRaw: string | null;
  /** frontmatter 解析结果（映射表）；缺失或解析失败时为 null。 */
  frontmatter: Record<string, unknown> | null;
  /** frontmatter 解析失败原因（YAML 错误信息）。 */
  frontmatterError: string | null;
  /** frontmatter 之后的部分，用于章节切分。 */
  body: string;
  /** 正文按二级标题（##）切分出的章节；标题前的散落内容归入序言章节。 */
  sections: SkillMarkdownSection[];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** 解析 SKILL.md：frontmatter 用 YAML 解析，正文按二级标题切分章节。 */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const match = content.match(FRONTMATTER_PATTERN);
  const frontmatterRaw = match?.[1] ?? null;
  const body = match ? content.slice(match[0].length) : content;

  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  if (frontmatterRaw !== null) {
    const document = parseDocument(frontmatterRaw, { uniqueKeys: true });
    if (document.errors.length > 0) {
      frontmatterError = document.errors[0]!.message;
    } else {
      const parsed = document.toJS() as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else {
        frontmatterError = "frontmatter must be a mapping";
      }
    }
  }

  return {
    frontmatterRaw,
    frontmatter,
    frontmatterError,
    body,
    sections: splitSections(body),
  };
}

/** 章节标题归一化：小写并压缩空白，用于中英文别名匹配。 */
export function normalizeSectionTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 按标题别名查找章节：命中第一个归一化标题匹配的章节。 */
export function findSectionByAliases(
  sections: readonly SkillMarkdownSection[],
  aliases: readonly string[],
): SkillMarkdownSection | undefined {
  const aliasSet = new Set(aliases.map((alias) => normalizeSectionTitle(alias)));
  return sections.find((section) => aliasSet.has(section.normalizedTitle));
}

function splitSections(body: string): SkillMarkdownSection[] {
  const sections: SkillMarkdownSection[] = [];
  const lines = body.split(/\r?\n/);
  let currentTitle: string | null = null;
  let currentLines: string[] = [];
  const flush = (): void => {
    const title = currentTitle;
    if (title === null) {
      // 标题前的散落内容只有在非空时才作为"序言"章节保留
      if (currentLines.join("").trim().length === 0) return;
      sections.push(makeSection("", currentLines));
      return;
    }
    sections.push(makeSection(title, currentLines));
  };
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      flush();
      currentTitle = heading[1]!.trim();
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return sections;
}

function makeSection(title: string, lines: readonly string[]): SkillMarkdownSection {
  const body = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    title,
    normalizedTitle: normalizeSectionTitle(title),
    body,
  };
}
