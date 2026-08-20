const SESSION_KEY = "memory-skills.access-key";

export function readAccessKey(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function saveAccessKey(accessKey: string): void {
  localStorage.setItem(SESSION_KEY, accessKey);
}

export function clearAccessKey(): void {
  localStorage.removeItem(SESSION_KEY);
}
