/**
 * Offline retrieval evaluation types. Fixtures are JSONL files where each line
 * is one EvaluationCase; the runner loads a corpus once per file and replays
 * every case deterministically.
 */

export interface EvaluationAsset {
  /** Distinct fixture asset id referenced by expected/forbidden lists. */
  id: string;
  kind: "memory" | "skill";
  /** Content a memory asset would carry; omit for skills assembled from parts below. */
  content?: string;
  /** Skill-only fields; searched text is `name description content` like production. */
  name?: string;
  description?: string;
  /** Skill markdown body (without frontmatter) for skill assets. */
  skillContent?: string;
  confidence?: number;
  /** Governance validity window in ISO timestamps; assets outside are excluded from recall. */
  validFrom?: string;
  validUntil?: string;
}

export interface EvaluationCase {
  id: string;
  /** Natural user request or search phrase. */
  query: string;
  /** Assets that must appear in top-K results. */
  expectedIds: string[];
  /** Assets that must never appear for this query. */
  forbiddenIds: string[];
  /** Recall@K and Precision@K cutoff; defaults to 3. */
  k?: number;
  /**
   * Critical cases are identity/preference samples guarded by the hard gate
   * (release threshold Recall@3 = 100%, forbidden hits = 0). Non-critical
   * cases feed the aggregate metrics but do not fail the gate by themselves.
   */
  critical?: boolean;
  /** Short explanation of what this case guards, in fixture language. */
  note: string;
}

export interface EvaluationCorpus {
  /** Evaluation "now" — frozen so validFrom/validUntil behave deterministically. */
  now: string;
  assets: EvaluationAsset[];
  cases: EvaluationCase[];
}

export interface CaseMetrics {
  caseId: string;
  recall: number;
  precision: number;
  reciprocalRank: number;
  forbiddenHits: number;
  returnedChars: number;
}

export interface EvaluationReport {
  fixture: string;
  totalCases: number;
  criticalCases: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  forbiddenHitRate: number;
  averageReturnedChars: number;
  /** Critical-case gate results: must be perfect to pass the release threshold. */
  criticalRecall: number;
  criticalForbiddenHitRate: number;
  /** Cases failing at least one threshold; kept so reports pinpoint regressions. */
  failures: Array<{ caseId: string; reason: string; metrics: CaseMetrics }>;
}
