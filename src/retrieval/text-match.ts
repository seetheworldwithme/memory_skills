const CJK_SEGMENT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const SEGMENT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
const PERSONAL_PRONOUNS = new Set(["我", "你", "您", "咱"]);

export function retrievalTerms(value: string): string[] {
  const segments = textSegments(value);
  const terms = new Set<string>();

  for (const segment of segments) {
    if (!CJK_SEGMENT.test(segment) || [...segment].length < 3) {
      terms.add(segment);
      continue;
    }
    const characters = [...segment];
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return [...terms];
}

export function lexicalScore(query: string, content: string): number {
  if (!query.trim()) throw new Error("query must not be empty");
  const queryTerms = retrievalTerms(query);
  if (queryTerms.length === 0) throw new Error("query must contain searchable text");
  const normalizedContent = content.toLocaleLowerCase();
  const nonCjkTerms = textSegments(query).filter((term) => !CJK_SEGMENT.test(term));
  const nonCjkMatches = nonCjkTerms.filter((term) => normalizedContent.includes(term)).length;
  const nonCjkScore = nonCjkMatches === 0 ? 0 : nonCjkMatches / Math.min(nonCjkTerms.length, 2);
  return Math.max(nonCjkScore, cjkPhraseScore(query, content));
}

export function hasLexicalMatch(query: string, content: string): boolean {
  return lexicalScore(query, content) > 0;
}

/**
 * Query fragments that actually matched the content, for match metadata in the
 * context contract. Returns normalized query terms contained in the content.
 */
export function matchedQueryTerms(query: string, content: string): string[] {
  const normalizedContent = content.toLocaleLowerCase();
  return retrievalTerms(query).filter((term) => normalizedContent.includes(term));
}

function cjkPhraseScore(query: string, content: string): number {
  const querySegments = cjkSegments(query);
  const contentSegments = cjkSegments(content);
  let best = 0;

  for (const querySegment of querySegments) {
    const characters = [...querySegment];
    if (characters.length < 2) continue;
    if (characters.length === 2) {
      if (contentSegments.some((segment) => segment.includes(querySegment))) best = 1;
      continue;
    }

    const windows = new Set<string>();
    for (let index = 0; index < characters.length - 2; index += 1) {
      windows.add(`${characters[index]}${characters[index + 1]}${characters[index + 2]}`);
    }
    const matches = [...windows].filter((window) => contentSegments.some((segment) => segment.includes(window))).length;
    if (matches > 0) best = Math.max(best, matches / Math.min(windows.size, 3));
  }

  return Math.min(best, 1);
}

function cjkSegments(value: string): string[] {
  return textSegments(value)
    .filter((segment) => CJK_SEGMENT.test(segment))
    .map((segment) => [...segment].map((character) => PERSONAL_PRONOUNS.has(character) ? "§" : character).join(""));
}

function textSegments(value: string): string[] {
  return value.toLocaleLowerCase().match(SEGMENT_PATTERN) ?? [];
}
