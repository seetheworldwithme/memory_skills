# 上游 TencentDB-Agent-Memory 借鉴结论（2026-08-21）

> 背景：对本项目拆分来源 `/Volumes/coding/application/TencentDB-Agent-Memory`
> 做了一次全面的设计对照（MemoryCore 的记忆治理、Skill 子系统、检索与路线图，
> 三路并行探索），本文记录落地取舍，供后续迭代引用。
> 另：本次对照确认本项目已完成原开发计划全部 19 个任务（Phase 5/6/7 见
> git 5966eba、22dfb2f、ba59e04、cc28924、0768d55、35f4f26）。

## 已借鉴并落地（本轮）

| 机制 | 上游位置 | 本项目落地 |
| --- | --- | --- |
| 召回遥测（hit/latency/策略过程指标 + bridge 调用记录） | `MemoryCore/src/core/report/metric-tracking-recall.ts`、MemoryProxy bridge-telemetry | `recall_log` 表（迁移 006）+ `ContextService.writeRecallLog`：requestId → 查询/命中资产/分数的持久化关联，补齐了"Agent 实际用了哪些检索"的数据底座；`POST /v1/recall-log/{list,get}` 只读端点 |
| 埋点铁律（同步 void、sink 异常静默吞、绝不影响主流程） | 上游 report 模块的统一模式 | 召回日志写入失败只记 `recall.log.failed` 事件，召回照常返回 |
| 反馈回流评测集 | 上游没有离线评测集（governance 路线图 Phase 4 仅规划） | `scripts/feedback-to-eval.mjs`：incorrect/outdated 反馈 → pending 样本（人工脱敏补全后并入 fixture）+ 采用率报告（北极星指标下界近似），评测 runner 对 pending 只展示不设门禁 |

## 下一步候选（已论证、未实施）

- **LLM 冲突合并提案**：上游 `MemoryCore/src/core/record/l1-dedup.ts` +
  `prompts/l1-dedup.ts` 的两阶段算法（向量/FTS 召回定候选 → 批量 LLM 判决），
  四元动作空间 `store | update | merge | skip` + `target_ids[]` 多对多 +
  `merged_timestamps` 并集保留演化时间线。治理优先版改法：判决结果作为
  Draft 决议进人工审核闸门（复用 ProposalService + prompt-registry 模式），
  审核通过后 apply 为"新版本 + 来源并集 + 旧条 Deprecated"。本项目
  `ConflictService` 目前只做确定性检测（归一化重复/检索词重合），缺"合并成
  什么"的提案能力——这是当前最有价值的空白。
- **合并版本化语义**：上游 `l1-writer.ts` 的 version 单调递增 + timestamps
  并集 + `source_message_ids` 溯源，是合并动作的版本化基础。
- **查询清洗 sanitize**（Task 11 前置便宜项）：上游 `sanitizeText` /
  `extractUserQueryText` 在检索前剥离注入噪声，实测可救活 FTS/向量命中率。
- **召回预算双阈值 + 稳定/动态注入分离**（prompt cache 友好）：上游
  auto-recall 的 `maxCharsPerMemory`/`maxTotalRecallChars` 与
  prepend/appendSystem 拆分，若未来做主动注入可参考。
- **Skill listing 注入格式**：上游 `skill-listing-prompt.ts` 的
  `<available_skills>` 清单 + char_budget 截断 + 强制措辞，MCP 召回输出
  形态可借鉴。

## 明确不抄（持续有效）

- Redis 分片定时器、分布式锁/续约/XCLAIM、Worker Pool、DLQ——单机
  `ManagedTimer`/串行队列等价且无运维负担；
- TCVDB/COS/quota/credit、Kafka+ClickHouse+OTel 全套观测——本地 SQLite
  事件表 + JSONL 足够；
- 三维租户隔离全链路贯穿——个人单 scope 即可；
- Skill 版本 TTL GC + KEEP_RECENT——与可审计性冲突，保留全量版本链；
- 上游 Skill v2 的"capture by default"哲学——其 v1 严门在自动判定下覆盖率
  只有 46% 后选择放弃门禁；本项目人工 Verify 恰好可以拿回结构化检查当
  人审 checklist（机器提示、人决策），两个教训互为镜像。

## 上游自己的空白（本项目的相对优势）

- 无离线评测集、无召回解释落地、Skill 使用效果追踪未接线
  （`SkillProposeResult` 两步确认设计过但没实现）；
- 删除传播只建了 generation log 溯源 DAG（input_refs/output_refs），
  没做反向查询与级联；本项目 `deleteEvidenceAndPropagate` 已落地；
- L2/L3 变更靠定时重归纳最终一致，本项目治理工单即时处置。

## 一个架构洞察

上游对删除传播的隐含答案是"L2/L3 是可重 derive 的派生视图，低层变更靠
定时重归纳最终一致"。治理优先版可以做得更好：利用溯源关系在删除时主动
列出受影响资产并生成待复核工单——上游建了数据结构但没走完的最后一步，
本项目 Task 14 已经走完。
