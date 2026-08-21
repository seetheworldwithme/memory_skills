/** 统一日期格式化：各页面共用，避免重复实现（审核项：formatDate 三处重复）。 */

/** 列表/详情用的短格式：月-日 时:分。 */
export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** 治理工作台用的完整日期：年-月-日。 */
export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}
