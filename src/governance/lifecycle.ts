export const GOVERNED_STATUSES = [
  "draft",
  "verified",
  "deprecated",
  "rejected",
  "archived",
] as const;

export type GovernedStatus = (typeof GOVERNED_STATUSES)[number];

export class GovernanceError extends Error {
  constructor(
    public readonly code: "INVALID_TRANSITION" | "INVALID_CONFIDENCE",
    message: string,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<GovernedStatus, ReadonlySet<GovernedStatus>>> = {
  draft: new Set(["verified", "rejected", "archived"]),
  verified: new Set(["deprecated", "archived"]),
  deprecated: new Set(["verified", "archived"]),
  rejected: new Set(["archived"]),
  archived: new Set(),
};

export function transitionStatus(
  current: GovernedStatus,
  target: GovernedStatus,
): GovernedStatus {
  if (current === target) return current;
  if (!ALLOWED_TRANSITIONS[current].has(target)) {
    throw new GovernanceError(
      "INVALID_TRANSITION",
      `cannot transition governed asset from ${current} to ${target}`,
    );
  }
  return target;
}

export function validateConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new GovernanceError(
      "INVALID_CONFIDENCE",
      "confidence must be a finite number between 0 and 1",
    );
  }
  return confidence;
}

