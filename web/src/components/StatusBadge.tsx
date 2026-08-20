import type { Status } from "../lib/api";

const labels: Record<Status, string> = {
  draft: "草稿",
  verified: "已验证",
  deprecated: "已弃用",
  rejected: "已拒绝",
  archived: "已归档",
};

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status--${status}`}>{labels[status]}</span>;
}
