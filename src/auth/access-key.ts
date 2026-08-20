import { createHash, timingSafeEqual } from "node:crypto";

export function accessKeyMatches(candidate: string, configured: string): boolean {
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(configured).digest();
  return timingSafeEqual(left, right) && candidate.length === configured.length;
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
