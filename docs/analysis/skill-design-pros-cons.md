# Skill 设计理念、优点与缺点

> 分析范围：`MemoryCore`
>
> 分析日期：2026-08-20
>
> 分析方式：设计文档与源码静态分析，未运行真实 Skill 抽取任务。

## 1. 结论摘要

MemoryCore 中的 Skill 不是普通的代码函数或静态插件，而是一种可持续演进的 Agent 资产：

> 系统从历史对话中识别可复用经验，把它保存为版本化、可检索、可携带辅助资源的 `SKILL.md`，供未来同一用户、团队或 Agent 再次使用。

Skill 可以保存三类内容：

1. **SOP 类型**：工作流、检查清单、调试路径、工具使用方式；
2. **Background 类型**：长期有效的项目、业务、领域和系统背景；
3. **Preference 类型**：用户或团队希望 Agent 遵守的操作习惯。

当前设计已经从“高精度、宁缺毋滥”转向“捕获优先、以后持续修正”：只要未来同一作用域可能受益，就倾向于保存；不确定时也倾向于先写入。

这使 Skill 具有很强的经验积累能力，但同时带来 Skill 膨胀、Memory 与 Skill 边界重叠、LLM 直接写入持久资产，以及质量治理不足等问题。

## 2. 核心设计理念

### 2.1 Skill 是可执行经验，不只是知识片段

一个 Skill 的标准载体是 `SKILL.md`，可以包含：

- 何时使用；
- 何时不使用；
- 必要输入；
- 操作步骤；
- 背景知识；
- 决策规则；
- 输出格式；
- 验证方法；
- 常见陷阱；
- 辅助脚本、模板、SQL 或其他资源。

相关提示词：[`MemoryCore/src/core/skill/prompts/skill-review-prompt.ts`](../../MemoryCore/src/core/skill/prompts/skill-review-prompt.ts)

### 2.2 复用价值以作用域为准，不要求全局通用

系统不再要求 Skill 对所有用户都通用。只要同一用户、团队或 Agent 下次会受益，Skill 就有保存价值。

这意味着稳定的项目路径、团队工作区 ID、输出格式偏好等具体信息，在确实长期稳定时可以原样保留；会随任务变化的 ID、分支、工单号则应该参数化。

### 2.3 Skill Library 是持续演进的版本库

Skill 支持：

- create：创建 v1；
- update：整体替换 `SKILL.md`；
- patch：局部字符串修改；
- files-write：写入辅助资源；
- files-remove：删除资源；
- versions：查看历史版本；
- search/listing：查找相关 Skill；
- export：导出完整 Skill。

更新操作使用 `expected_version` 做乐观并发控制，避免两个写者静默覆盖。

相关实现：

- [`MemoryCore/src/core/skill/skill-core.ts`](../../MemoryCore/src/core/skill/skill-core.ts)
- [`MemoryCore/src/core/skill/skill-versioning.ts`](../../MemoryCore/src/core/skill/skill-versioning.ts)

### 2.4 先查已有 Skill，再决定新建或修订

Skill Review Agent 会先查看当前 Agent 已有的 Skill：

- 数量少时直接注入全部列表；
- 数量多时先让 LLM 从对话生成 BM25 查询；
- 相关检索失败时退化为最近更新的 Top-N；
- 如果已有 Skill 覆盖当前主题，优先 patch 或 update，而不是创建近似重复项。

相关实现：[`MemoryCore/src/core/skill/skill-extractor.ts`](../../MemoryCore/src/core/skill/skill-extractor.ts)

### 2.5 LLM Review Agent 通过受限工具直接修改 Skill Library

Review Agent 可以使用：

- `skill_list`；
- `skill_view`；
- `skill_create`；
- `skill_update`；
- `skill_patch`；
- `skill_files_write`。

它不能调用 delete 和 files-remove，降低了自动抽取流程的破坏能力。工具错误以结构化 JSON 返回，使 Agent 可以重新读取版本、修正参数并重试。

相关实现：[`MemoryCore/src/core/skill/skill-tools.ts`](../../MemoryCore/src/core/skill/skill-tools.ts)

### 2.6 对话先归档，再异步抽取

每轮对话会进入 Skill Conversation Buffer。达到以下任一条件后归档并触发抽取：

- 工具调用次数达到阈值，默认 10 次；
- 累计字节达到阈值，默认 40KB；
- 单次请求达到压缩阈值；
- 合并后内容过大，进入 oversize 策略。

Worker 获取任务后读取归档，调用 SkillExtractor，并通过 SkillCore 工具直接落库。

相关实现：

- [`MemoryCore/src/core/skill/conversation-add/add-handler.ts`](../../MemoryCore/src/core/skill/conversation-add/add-handler.ts)
- [`MemoryCore/src/core/skill/conversation-add/extract-worker.ts`](../../MemoryCore/src/core/skill/conversation-add/extract-worker.ts)

### 2.7 多层可靠性与隔离

Skill 使用 user、team、agent、task、session 和 instance 等身份字段。Worker 采用 Agent 级抽取锁、锁续租、任务互斥、原子队列、重试和 DLQ，以减少多节点重复抽取及进程崩溃丢任务。

## 3. 优点

### 3.1 把隐性经验转化为未来可执行的资产

普通 Memory 更适合保存“发生过什么”，Skill 更适合保存“下次应该怎样做”。它可以将一次成功的调试过程转化为带步骤、判断条件和验证方式的 SOP。

### 3.2 能保存辅助资源

Skill 不局限于一段文本，还可以携带脚本、模板、SQL、Prompt 和其他文件。这使它能够真正减少未来执行成本，而不是只提供模糊提醒。

### 3.3 个性化和团队化程度高

“只对当前用户或团队有用”不再是拒绝理由。对于长期绑定同一工作环境的 Agent，这比追求全局通用 Skill 更符合实际。

### 3.4 支持逐步完善

一个 Skill 可以先以“部分但有用”的状态创建，以后通过新对话 patch 或 update。版本历史和乐观锁为持续演进提供了基础。

### 3.5 主动避免盲目创建重复 Skill

抽取前会列出或搜索已有 Skill，并要求 Review Agent 优先更新已有主题。这比每次对话都独立生成一个新文件更成熟。

### 3.6 自动抽取工具权限受到限制

Review Agent 没有删除能力，不能在自动抽取阶段销毁整个 Skill；受保护 Skill 也不允许编辑。配合 owner、team、frontmatter、路径和资源大小校验，可以降低误操作范围。

### 3.7 写入有版本并发保护

更新、patch 和资源修改都要求调用方携带读取到的 `expected_version`。版本过期时重新读取再重试，避免并发写入静默覆盖。

### 3.8 对慢速 LLM 任务有较完整的可靠性设计

抽取 Worker 包含：

- Agent 级排他锁；
- 长任务锁续租；
- 队列崩溃恢复；
- transient/permanent 错误分类；
- 重试和 DLQ；
- 多 Worker Pool；
- Task ID 与可观测链路关联。

这使 Skill 抽取更接近一个正式的后台任务系统，而不是脆弱的 fire-and-forget 调用。

### 3.9 存储和检索可以降级

Skill 元数据可以使用 SQLite 或 TCVDB，资源可以使用本地文件或 COS，路由可以使用 BM25、Embedding 或 Hybrid。缺少 Embedding 时可以退化为 BM25。

相关实现：[`MemoryCore/src/core/skill/skill-config.ts`](../../MemoryCore/src/core/skill/skill-config.ts)

## 4. 缺点与风险

### 4.1 “不确定就保存”会造成 Skill 膨胀

当前 v2 提示词明确采用 capture-first 策略，并认为未使用的 Skill 成本较低。这有利于提高覆盖率，但长期可能产生：

- 高度相似的 Skill；
- 只适用一次的狭窄 Skill；
- 不完整或未经验证的 Skill；
- 已经过期但仍参与路由的 Skill；
- 用户偏好、项目背景和 SOP 混杂。

系统目前缺少强制的质量分数、采用率、命中后成功率和自动淘汰机制。

### 4.2 Skill 与 Chat Memory 的边界不够清晰

三类 Skill 中：

- Background Skill 与 L2 场景记忆高度重叠；
- Preference Skill 与 L1 偏好记忆、L3 Persona 高度重叠；
- SOP Skill 才是最明显独立于 Memory 的类别。

同一条信息可能同时存在于 Persona、L1 和 Skill 中。一旦三处更新节奏不同，就可能互相矛盾。

建议的语义边界：

- Memory：事实、事件、状态和用户特征；
- Skill：遇到某类任务时可执行的行为规则；
- Persona：经过多次确认的稳定长期特征。

### 4.3 LLM 读取不可信对话后拥有直接写权限

Review Prompt 对角色捕获和 Prompt Injection 做了较强的文字防御，但防御仍主要依赖模型遵循系统提示。

风险场景包括：

- 对话内容诱导 Review Agent 创建恶意 Skill；
- 将一次性命令保存为长期规则；
- 修改已有 Skill 中的安全步骤；
- 将敏感信息写入 SKILL.md 或辅助资源。

没有默认的人类审批或候选区，模型成功调用工具后就直接成为持久资产。

### 4.4 归档边界不是任务语义边界

默认按照 10 次工具调用或 40KB 触发归档。这些阈值只能说明内容规模，不能说明一个任务已经完成。

可能出现：

- 任务中途归档，结论尚未形成；
- 失败修复发生在下一批，前一批先生成错误 Skill；
- 一个任务被拆成多个互不完整的 Skill；
- 多个小任务被合并进一个归档。

### 4.5 压缩与头尾截断可能损害 Skill 正确性

大工具调用和工具结果会只保留头尾，超大归档也会切分或截断。对于日志、补丁、SQL、堆栈和中间推理，真正决定问题的内容可能恰好位于中间。

由截断材料生成的 Skill 可能结构完整，却遗漏关键条件。

### 4.6 自动抽取成本和延迟较高

`SkillExtractor` 每次调用都会走 LLM，不做对话级缓存。Skill 数量超过注入上限时，还可能先进行一次短 LLM 查询生成，再进行多轮带工具的 Review Agent 调用。

成本来源包括：

- 查询关键词生成；
- Skill Review 多轮迭代；
- list/view 工具调用；
- create/update/patch 工具调用；
- 大型 SKILL.md 工具参数输出。

### 4.7 队列和存储架构复杂

可靠性设计引入了 Redis、归档文件、COS、任务 JSON、Agent 队列、互斥锁、抽取锁、锁续租、Worker Pool 和 DLQ。

它可以提升可靠性，但也让以下问题更难排查：

- 为什么某个会话没有生成 Skill；
- 为什么同一个任务被重复抽取；
- 为什么任务一直停留在队首；
- 为什么锁续租失败；
- 为什么任务进入 DLQ；
- 为什么 Skill 已写入但资产页面不可见。

### 4.8 transient 错误可能长期阻塞队首

Worker 将 401、403、429、5xx、网络和超时等视为 transient，并倾向于无限重试、保持任务不丢失。

这种策略适合短暂故障，但如果凭据长期失效或上游配置永久错误，坏任务可能持续占据同一 Agent 的队首，形成饥饿和资源浪费。

### 4.9 默认 BM25 路由有召回限制

默认 Skill routing 使用 BM25。它成本低、可解释、可离线运行，但对同义改写、跨语言表达和概念性查询不如 Embedding 稳定。

代码中虽然保留了 Skill 名称子串 fast-path，但设计结论是暂不接入，因为全量拉取 Skill 的 I/O 成本可能超过收益。

相关实现：[`MemoryCore/src/core/skill/skill-fast-path.ts`](../../MemoryCore/src/core/skill/skill-fast-path.ts)

### 4.10 缺少正式的质量生命周期

当前生命周期偏重创建、更新、版本和删除，缺少以下治理维度：

- 草稿、候选、已审核、已发布状态；
- 命中次数；
- 命中后任务成功率；
- 最近真正使用时间；
- 用户接受或拒绝次数；
- 自动过期条件；
- 相似 Skill 聚类与合并建议；
- 适用软件版本与环境约束。

### 4.11 设计和实现快速演进导致契约漂移

例如 `skill-core.ts` 文件顶部仍将 delete 描述为“head status=archived”，但当前实现注释和代码已经改为物理删除所有版本及资源。

这种同文件内的描述冲突说明 Skill 模块演进很快，设计文档、接口语义和实际实现可能不同步。

## 5. 建议的改进方向

### 5.1 引入候选区和可配置审批

建议把抽取结果分成：

```text
LLM 提出候选
  ↓ 自动质量检查
Draft Skill
  ↓ 用户确认 / 高置信自动批准
Published Skill
```

低风险个人环境可以自动发布；团队共享、高风险或强合规环境应该要求审批。

### 5.2 收紧自动捕获范围

可以继续保留 capture-first，但增加软质量评分：

- 是否跨会话复现；
- 是否包含明确触发条件；
- 是否有可执行步骤或稳定背景；
- 是否有验证方法；
- 是否与已有 Skill 高度相似；
- 是否只是临时状态；
- 是否包含敏感信息。

低分候选先进入 Draft，而不是直接污染正式路由。

### 5.3 明确 Memory、Persona 与 Skill 的冲突优先级

建议建立统一规则，例如：

1. 用户当前明确指令；
2. 经过确认的 Published Skill；
3. 最近且高置信的 L1；
4. Persona；
5. 较旧的 Background Skill 或场景总结。

还需要明确“事实变化”是否应自动 patch 相关 Skill。

### 5.4 使用任务完成信号辅助归档

除了工具次数和字节数，还可以增加：

- Agent 明确调用 `task_complete`；
- 用户确认问题已解决；
- Git/Test/Deploy 等验证事件成功；
- 会话长时间空闲；
- 主 Agent 主动请求 Skill 抽取。

这样更接近语义完整的任务边界。

### 5.5 建立 Skill 使用反馈闭环

每次 Skill 被路由和使用时记录：

- 是否被主 Agent实际读取；
- 是否遵循；
- 任务是否成功；
- 用户是否纠正；
- Skill 是否被后续 patch；
- 路由是否误命中。

这些指标可以用于排序、降权、过期和合并。

### 5.6 限制 transient 队首阻塞

可以增加：

- 指数退避；
- 最大连续重试时间；
- 延迟队列；
- 熔断器；
- 将长期 transient 任务移动到等待区，让同 Agent 的后续任务继续执行。

### 5.7 增加敏感信息扫描

在 `skill_create`、`skill_update` 和 `skill_files_write` 真正落库前，增加确定性的 Secret/PII 扫描，而不是只依赖 Review Prompt 中的禁止规则。

### 5.8 定期执行 Skill 整理任务

建议后台周期性产生建议而不是直接修改：

- 合并近似 Skill；
- 标记长期未使用 Skill；
- 检测互相矛盾的规则；
- 检测过时的软件版本和路径；
- 检测缺少验证步骤的 SOP；
- 建议从 Published 降级为 Archived。

## 6. 最终评价

MemoryCore 的 Skill 设计最有价值的地方，是把 Agent 在一次会话中形成的隐性经验转化为可以搜索、修改、携带资源和重复执行的正式资产。

它已经具备版本、权限、检索、资源和后台任务可靠性，工程完整度较高。当前最大的不足不是功能缺失，而是治理策略偏向“先收集再说”：自动写入门槛较低，而质量反馈、人工审批、自动淘汰和 Memory/Skill 冲突处理仍然偏弱。

对于个人开发助手，这种取舍可能非常有效；对于多人共享、生产运维、安全操作或受监管环境，建议在正式使用前补上候选区、审批、敏感信息扫描和质量生命周期。

