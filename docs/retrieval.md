# 混合检索（Task 10）

本文档描述 v0.5 引入的可替换语义检索层：接口边界、融合算法、同步机制与启用门槛。

## 架构边界

```
ContextService
   │ 只依赖 Retriever 接口（rank: 治理过滤后的文档 → 排序候选）
   ├── LexicalRetriever          默认：包装既有 text-match 词法打分，与基线逐位一致
   └── HybridRetriever           可选：词法 + 向量双通道确定性融合
         ├── EmbeddingProvider   供应商无关（mock / openai 兼容），复用 LLM Provider 的注册表模式
         └── VectorIndex         存储无关（第一版 SQLite：元数据 + JSON 向量 + JS 余弦）
```

关键约束（对应开发计划 Task 10 第 2、4 条）：

- **ContextService 不感知厂商与数据库**：换 Embedding 供应商或向量库只替换 `EmbeddingProvider` / `VectorIndex` 实现；
- **治理交集优先**：候选列表由 `MemoryService.listRecallable` / `SkillService.listRecallable` 生成（已完成作用域、状态、有效期过滤），向量命中只在与该列表求交后参与排序——向量通道只能改变已过滤候选的排序与入选，永远不能把未通过治理过滤的资产带入结果；
- **读路径不写库**：召回只读向量索引；写入发生在人工触发的 `POST /v1/retrieval/sync` 与治理状态转换后的自动同步（见下文）。

## 融合算法（确定性）

对每个候选：

- 词法分 = `lexicalScore(query, text) * weight`（记忆的 weight 为 governance.confidence，Skill 为 1；与词法路径完全一致）；
- 向量分 = `max(0, 余弦相似度)`；
- 通道激活：词法分 > 0，或 余弦 ≥ `minVectorCosine`（默认 0.5，模型相关，见下文评测数据）；
- **融合分 = 激活通道的加权平均** `Σ(w·s) / Σ(w)`，而不是固定权重和。

"激活通道归一化"是关键设计：向量通道未激活（含 Mock 零向量、阈值未达、索引为空）时，融合分退化为纯词法分，因此混合管线在不产生语义增益的情况下与词法路径**逐位一致**——这是离线无回归证明的基础。排序为融合分降序 + 稳定排序（保持文档枚举顺序，与词法基线的排序语义一致）。

`match.strategy` 语义：`lexical`（仅词法命中）、`vector`（仅语义命中，词法零分——词法召回不到的那类资产）、`hybrid`（双通道命中）。

## 可用性与降级

查询向量或索引任何一步失败（网络、超时、响应非法）都降级为纯词法排序：

- 召回读路径绝不因 Embedding 服务故障而失败；
- 契约 `warnings` 返回 `RETRIEVAL_DEGRADED_LEXICAL`；
- 诊断事件 `context.recall.completed` 新增 `retrievalStrategy` 字段（lexical / hybrid）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_SKILLS_RETRIEVAL` | `lexical` | `lexical` / `hybrid`；混合模式需 Embedding 配置齐全 |
| `MEMORY_SKILLS_EMBEDDING_PROVIDER` | `mock` | `mock`（零向量，语义通道恒不激活）/ `openai`（OpenAI 兼容 /embeddings） |
| `MEMORY_SKILLS_EMBEDDING_MODEL` | mock 时 `mock-embedding` | 非 mock 必填；同时是向量索引的版本键，换模型后旧向量自动失效，需重跑同步 |
| `MEMORY_SKILLS_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | 兼容端点 |
| `MEMORY_SKILLS_EMBEDDING_API_KEY_ENV` | `OPENAI_API_KEY` | 密钥环境变量名（引用，不是密钥值） |
| `MEMORY_SKILLS_EMBEDDING_TIMEOUT_MS` / `_MAX_RETRIES` / `_BATCH_SIZE` | 30000 / 1 / 16 | 超时、额外重试、同步批量 |
| `MEMORY_SKILLS_HYBRID_LEXICAL_WEIGHT` / `_VECTOR_WEIGHT` | 1 / 1 | 融合权重 |
| `MEMORY_SKILLS_HYBRID_MIN_COSINE` | 0.5 | 向量通道激活阈值（精确率护栏，模型相关，见下文评测数据） |

向量索引与主库同用一个 SQLite 文件（`asset_embeddings` 表，WAL 支持并发读写）。

## 同步流程

### 状态转换后自动同步（默认行为）

hybrid 模式下，记忆/Skill 的治理状态转换（Verify、Reject、归档等）成功后，服务端自动对该资产所在作用域跑一次增量向量同步。解决的问题：新 Verify 的资产若要等人工同步才进向量索引，在此之前的召回只走词法通道，语义改写类查询会漏掉它。

- 同步是**索引维护**，不是提案也不是发布，仍在治理边界内；模型永远不经此路径产生 Verified 资产；
- 增量语义与手动同步一致：内容指纹未变跳过，离开可召回集（rejected/archived/deprecated）的向量行清理，开销只与实际变更的资产数成正比；
- **失败只记事件，不影响治理操作本身**：Embedding 服务故障时 Verify/Reject 照常成功，审计事件 `retrieval.auto_sync.failed`（只含错误码与错误名）留待排查，恢复后的下一次转换或手动同步会补齐索引；
- 成功同样记 `retrieval.auto_sync.completed` 事件（含 embedded/removed 计数）；
- 词法模式（未配置 Embedding）不触发同步。

### 手动全量同步

```bash
# 初始化索引、更换 Embedding 模型后补齐、或自动同步失败后补救时手动触发
curl -X POST "$MEMORY_SKILLS_URL/v1/retrieval/sync" \
  -H "authorization: Bearer $MEMORY_SKILLS_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"scope":{"userId":"local-admin","teamId":"local","agentId":"default"}}'
```

增量策略：内容指纹（SHA-256 前 32 位）未变跳过；已归档/删除资产的向量行清理。`includeDraft: true` 可把 Draft 资产也嵌入索引（配合 `includeDraft` 召回调试用；自动同步永远只覆盖 Verified 资产）。

## 启用门槛与真实模型评测结论（2026-08-20）

按开发计划的发布门槛："只有评测集 Recall/Precision 有显著提升且禁止命中不退化时才默认开启"。

**词法侧护栏（离线、确定性）：**

- `npm run eval:retrieval`——词法路径的基线门禁（基线 `evals/baselines/context-recall.v0.3.json`，含语义改写用例 zh-057~059 / en-023，词法对它们零命中）；
- `npm run eval:retrieval -- --hybrid`——Mock 零向量走完整混合管线，断言与词法路径逐用例一致，证明接入本身零回归。

**真实模型测量（`MEMORY_SKILLS_SMOKE=1 npm run smoke:retrieval-hybrid`，或网格扫描脚本调参）：**

用 OpenAI 兼容端点对两份评测夹具做参数网格扫描（阈值 × 权重），已对比三个配置（2026-08-20/21 同一评测集、同一扫描口径）：

| 配置 | 零退化点 | 该点收益 | 语义改写命中 | 嵌入速度 |
| --- | --- | --- | --- | --- |
| text-embedding-3-small（xiaoai.plus 中转） | ≈0.60 | 12 用例改善，ΔRecall +0.098 | 0/4 | 中 |
| **text-embedding-3-large（xiaoai.plus 中转，当前投产）** | **0.50** | **22 用例改善，ΔRecall +0.205 / ΔMRR +0.213 / ΔPrecision +0.013，禁止命中增量 0** | **3/4（zh 全中）** | 慢（批量 219ms/条，单次查询经中转偶发数秒） |
| BAAI/bge-m3（SiliconFlow 直连） | 0.70 | 13 用例改善，ΔRecall +0.114 / ΔMRR +0.146 / ΔPrecision +0.009，禁止命中增量 0 | 2/4 | **快（批量 16ms/条，约 13 倍速差）** |

bge-m3 补充实验：官方检索指令前缀（`Represent this sentence for searching relevant passages: `）**无净收益**——零退化点收益降至 11 用例（precision 变正但召回增益缩水），不采用。

关键发现：

1. **权重不是主导参数**（1:1 与 3:1 差异在噪声内），阈值才是——small 与 bge-m3 对中文的余弦各向异性都严重（无关对与改写对区间重叠），没有全局阈值能同时挡住无关对、放进改写对；large 的判别力显著更强。
2. **均值中心化（余弦减候选集背景均值）未能根治**，只把可用点略微提前。
3. 残余的边界模糊用例（如"怎么提高英语阅读速度" vs 阅读器资产、"日历软件推荐" vs 自家日历 App）属于"话题相近但事实无关"，需要 Reranker（Task 11）或更强的模型判别，不是阈值能解决的。
4. **判别力与速度的反向权衡**：large 零退化收益约为 bge-m3 的两倍、语义改写多命中一条；bge-m3 快约 13 倍且直连更稳定。当前按"召回质量优先"投产 large + 阈值 0.5。

**推荐配置**（已写入本地 `.env`，`text-embedding-3-large` + `MEMORY_SKILLS_HYBRID_MIN_COSINE=0.5`）在评测集上满足启用门槛：显著提升且禁止命中零退化。注意 large 经中转的延迟明显（建议配 `MEMORY_SKILLS_EMBEDDING_TIMEOUT_MS=60000`）；若延迟成为主要矛盾，可切换 bge-m3 + 阈值 0.70（收益缩小但仍为正，`.env` 中留有注释配置）。**换任何 Embedding 模型时必须三件事一起做：改模型配置、按新模型重调阈值、重跑 `/v1/retrieval/sync`——只换模型不调阈值会立即进入大量误召回状态。**

## Mock 零向量的取舍

Mock Embedding 返回零向量（余弦恒为 0，向量通道永不激活），而不是哈希伪向量：

- 哈希向量之间的随机余弦会引入不可控噪声，破坏"混合接入零回归"的确定性证明；
- 语义增益本来就只能来自真实模型，伪造的语义信号只会让离线指标失真；
- 需要验证向量机制时，单元测试注入带预设向量的 Fake Provider（见 `tests/hybrid-retrieval.test.ts`）。
