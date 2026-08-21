# Web 前端代码审核（Vercel Web Interface Guidelines）

- 审核日期：2026-08-21
- 依据：[vercel-labs/web-interface-guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)（当日最新版）
- 范围：`web/index.html`、`web/src/App.tsx`、`web/src/main.tsx`、`web/src/styles.css`、`web/src/components/*`、`web/src/pages/*`（不含测试文件）
- 优先级说明：🔴 建议尽快处理（含真实 bug / 可访问性阻断点）；🟡 建议排期处理；🟢 可选优化

## 总览

| 优先级 | 数量 | 主要类别 |
| --- | --- | --- |
| 🔴 | 5 | CSS 无效值（真实 bug）、焦点环缺失、模态框键盘/焦点管理、破坏性操作无确认、`transition: all` |
| 🟡 | 12 | aria-live 缺失、URL 状态不同步、prefers-reduced-motion、图标 aria-hidden、输入框属性 |
| 🟢 | 8 | hover 补全、tabular-nums、死代码清理、工具函数去重等 |

做得好的地方（直接通过 ✅）：`:root { color-scheme: dark }` + `<meta name="theme-color">`；viewport 未禁用缩放；日期全部走 `Intl.DateTimeFormat`；空状态与加载态文案统一用 `…`；列表标题有 `line-clamp` 防溢出；提交中按钮禁用 + 文案切换；图标按钮（模态关闭）有 `aria-label`；搜索输入有 `aria-label` 且受控过滤开销低。

---

## web/index.html

- 🟢 index.html:2 - 无“跳到主内容”的 skip link；键盘用户需逐个 Tab 过侧边栏导航按钮（SPA 控制台，影响有限）

## web/src/App.tsx

- 🔴 App.tsx:42 - 登录输入为密钥类字段，缺 `spellCheck={false}`（指南：邮箱/密钥/用户名一律关闭拼写检查）
- 🟡 App.tsx:42 - `login-error` 异步错误提示缺 `aria-live="polite"`（或 `role="alert"`），读屏用户感知不到登录失败
- 🟡 App.tsx:37 - 页面切换（memory/skills/governance）只存 `useState`，未同步到 URL；刷新/分享/后退均丢失状态（指南：tabs、filters 应进 query params，可用 nuqs 或原生 `history.replaceState`）
- 🟡 App.tsx:33,37,42 - lucide 装饰性图标（BrainCircuit、ShieldCheck、Sparkles 等）未加 `aria-hidden="true"`，读屏会朗读无意义 SVG
- 🟡 App.tsx:42 - story 区 `<h2>`（“让经验留下…”）出现在 `<h1>`（“登录 Memory Skills”）之前，标题层级跳跃；story 标题改为 `p`/`div` 或调整层级
- 🟢 App.tsx:42 - 提交按钮因输入为空被禁用；指南倾向“保持可点击，提交时校验并聚焦错误”，当前实现可接受但可改进

## web/src/styles.css

- 🔴 styles.css:61 - `text-decoration:line` 是**无效 CSS 值**（应为 `line-through`），`.diff-block--removed` 的删除线目前根本不渲染——这是实际 bug，顺手就修
- 🔴 styles.css:19 - `.search input { outline:0 }` 移除焦点环且无任何替代；应给 `.search` 补 `:focus-within` 边框/阴影（参照 `.key-input:focus-within` 的做法）
- 🔴 styles.css:13,23 - `transition:.18s ease` 不带属性名等价于 `transition: all`（nav 按钮、feedback-options 按钮）；列出具体属性（`color, background-color, border-color`）
- 🔴 styles.css:24 - `.modal` 缺 `overscroll-behavior: contain`（模态内滚动会穿透到底层页面）；且无 `max-height` + `overflow:auto`，小屏长表单会溢出视口
- 🟡 styles.css:27 - `pulse` 动画（session-check、signal-lines）未处理 `prefers-reduced-motion`；signal-lines 是无限装饰循环，必须在 reduced-motion 下停止
- 🟡 styles.css:18 - `.secondary` 与 `.danger` 完全没有 `:hover` 状态，视觉反馈缺失（`.primary` 有）
- 🟢 styles.css:28 - `.brand>div,nav p,nav button:not(.active){ }` 是空规则死代码，可删
- 🟢 styles.css:5 - 按钮未设 `touch-action: manipulation`（消除移动端双击缩放延迟）
- 🟢 styles.css:29 - 移动端 sidebar 贴底，可补 `padding-bottom: env(safe-area-inset-bottom)` 适配全面屏
- 🟢 styles.css:17 - `.page-head h1`、`.detail-title h2` 可加 `text-wrap: balance` 防孤行
- 🟢 styles.css:21 - `.facts dd`（可信度百分比等数字列）可加 `font-variant-numeric: tabular-nums`

## web/src/pages/MemoryPage.tsx

- 🔴 MemoryPage.tsx:95 - 新建记忆对话框缺键盘与焦点管理：无 Escape 关闭、无焦点圈禁（focus trap）、无 `role="dialog"`/`aria-modal="true"`、打开时未聚焦首个输入；提交失败的错误提示未聚焦
- 🔴 MemoryPage.tsx:81,90 - “拒绝”“归档”为不可逆治理操作，单击立即执行，无确认弹窗或撤销窗口（指南：destructive actions never immediate）
- 🟡 MemoryPage.tsx:62-63 - `error-banner` / `info-banner` 异步出现，缺 `aria-live="polite"`
- 🟡 MemoryPage.tsx:66 - 搜索输入缺 `type="search"`（清除按钮/移动端搜索键）与 `autocomplete="off"`
- 🟡 MemoryPage.tsx:71 - 列表直接 `.map()` 渲染；记忆数超过 50 条后考虑 `content-visibility: auto` 或虚拟化
- 🟢 MemoryPage.tsx:99 - `formatDate` 在 MemoryPage/SkillsPage/GovernancePage 三处重复实现，可抽到 `lib/` 共享

## web/src/pages/SkillsPage.tsx

- 🔴 SkillsPage.tsx:68 - 创建 Skill 对话框与 MemoryDialog 同样缺 Escape 关闭、焦点圈禁、`role="dialog"`、错误聚焦
- 🔴 SkillsPage.tsx:37 - “拒绝”“归档”一键执行，同 MemoryPage，缺确认/撤销
- 🟡 SkillsPage.tsx:68 - 名称输入是代码标识符：缺 `spellCheck={false}`、`autocomplete="off"`；`pattern` 建议配 `title` 属性说明格式（虽有 small 提示文案，属可选）
- 🟡 SkillsPage.tsx:16 - `error-banner` / `info-banner` 缺 `aria-live`；搜索输入缺 `type="search"` / `autocomplete="off"`
- 🟢 SkillsPage.tsx:16 - 同 MemoryPage，列表无虚拟化；`formatDate` 重复（见上）

## web/src/pages/GovernancePage.tsx

- 🔴 GovernancePage.tsx:77 - “降权 N 条过期记忆”是批量不可逆动作（虽可续期恢复，文案已说明），建议加二次确认对话框
- 🟡 GovernancePage.tsx:82-83 - `info-banner`（note）/ `error-banner` 缺 `aria-live="polite"`
- 🟢 GovernancePage.tsx:113 - `item.validUntil!` 非空断言依赖列表来源约定，可改为渲染前过滤，属代码健壮性

## web/src/components/EvidenceBlock.tsx

- 🟡 EvidenceBlock.tsx:41 - `<time>` 缺 `dateTime` 属性（应为 `<time dateTime={record.capturedAt}>`）；且用 `toLocaleString("zh-CN")` 而非 `Intl.DateTimeFormat`，与其他页面 `formatDate` 风格不一致
- 🟢 EvidenceBlock.tsx:29 - 加载态文案已用 `…` ✅

## web/src/components/FeedbackBar.tsx

- 🟡 FeedbackBar.tsx:47-48 - 提交结果（feedback-note）与错误（feedback-error）异步出现，缺 `aria-live="polite"`

## web/src/components/StatusBadge.tsx

✓ pass

## web/src/main.tsx

✓ pass

---

## 建议的修复顺序

1. **一行真 bug**：`styles.css:61` `text-decoration:line` → `line-through`。
2. **模态框可达性包**（MemoryDialog + SkillDialog）：Escape 关闭、初始聚焦、焦点圈禁、`role="dialog" aria-modal="true"`；配套 CSS `overscroll-behavior: contain` + `max-height`。
3. **破坏性操作确认**：拒绝/归档/批量降权加确认对话框（或“已拒绝 · 撤销”式提示条）。
4. **焦点与动效**：`.search` 焦点样式、两处 `transition: all` 列属性、`prefers-reduced-motion` 停用 pulse。
5. **批量小项**：全局给异步提示容器加 `aria-live="polite"`；lucide 图标 `aria-hidden`；密钥/标识符输入关 spellcheck；搜索框 `type="search"`。
6. **可选**：页面/搜索状态进 URL、列表虚拟化、`formatDate` 去重、hover/tabular-nums/死代码清理。

---

## 修复记录（2026-08-21，当日完成）

第 1–5 步全部完成，第 6 步完成了轻量项；验证：`npm run typecheck` ✓、`npm run test:web` 10/10 ✓、`npm run build:web` ✓。

已修复：

- ✅ `text-decoration:line-through`（删除线 bug）
- ✅ 新增 `web/src/components/Modal.tsx`：`Modal`（Escape 关闭、焦点圈禁、关闭后焦点还原、`role="dialog" aria-modal`）与 `ConfirmDialog`（二次确认）；`MemoryDialog`/`SkillDialog` 迁移到该外壳；CSS 补 `max-height`/`overscroll-behavior: contain`
- ✅ 拒绝/归档（Memory/Skill 详情）与治理工作台批量降权全部改为二次确认；治理按钮请求期间禁用防重复提交
- ✅ `.search:focus-within` 焦点样式；两处 `transition: all` 改列具体属性；`prefers-reduced-motion` 停用 pulse 与过渡
- ✅ 错误提示 `role="alert"`、信息提示 `role="status"`（登录/两页 banner/反馈条/模态错误）
- ✅ 全部 lucide 装饰图标 `aria-hidden="true"`
- ✅ 密钥与 Skill 名称输入 `spellCheck={false}`（名称另补 `autoComplete="off"` 与 `pattern` 的 `title`）；搜索输入 `type="search"` + `autoComplete="off"`
- ✅ 登录页 story 标题 h2 → `p.story-headline`，消除 h1 前的标题层级跳跃
- ✅ 新增 `web/src/lib/format.ts`，三处重复的 `formatDate` 与 `EvidenceBlock` 的 `toLocaleString` 统一收敛；`<time>` 补 `dateTime` 属性
- ✅ `.secondary`/`.danger` 补 hover 与禁用态；`.facts dd` 补 `tabular-nums`；标题 `text-wrap: balance/pretty`；按钮 `touch-action: manipulation`；移动端 sidebar `env(safe-area-inset-bottom)`；清除空规则死代码

未处理（有意保留，建议单独立项）：

- ⏸ 页面/搜索/选中项状态同步到 URL（涉及路由方案选型，行为变更较大）
- ⏸ 资产列表虚拟化（当前本地数据量未达阈值，>50 条再引入）
- ⏸ skip link、登录提交按钮“空值也可点击后校验”（收益较低）
