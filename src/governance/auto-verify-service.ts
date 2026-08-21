import type { Scope } from "./types.js";
import type { AutoVerifyConfig, AutoVerifyEvaluation } from "./auto-verify.js";
import { evaluateAutoVerify } from "./auto-verify.js";
import type { MemoryAsset } from "../memory/types.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";

/** 单条 Draft 的自动 Verify 结果：ruleCodes/errorCode 说明原因，绝不携带内容。 */
export interface AutoVerifyResult {
  id: string;
  passed: boolean;
  ruleCodes: string[];
  errorCode?: string;
}

/**
 * 规则化自动 Verify 服务：对刚创建（或现存）的 Draft 逐条做确定性评估，
 * 通过者立即沿既有治理管线转换 draft→verified（transitionStatus 校验 +
 * verifiedBy=auto 标记）。失败安全红线：单条评估/转换抛错只影响该条
 * （留 Draft、结果带 errorCode），绝不中断整批，也绝不放行存疑资产。
 * 注意：审计事件与向量同步由 HTTP 层负责（与人工 Verify 同一管线），
 * 本服务只负责"评估 + 转换"这一原子动作。
 */
export class AutoVerifyService {
  constructor(private readonly deps: {
    memory: MemoryService;
    repository: SqliteRepository;
    /** 只接受已开启的配置：是否开启由组装层（http-server/server.ts）决策。 */
    config: AutoVerifyConfig & { enabled: true };
  }) {}

  /** 提案运行后的即时评估：只处理本次新建的 Draft（verifyCreated）。 */
  verifyCreated(scope: Scope, created: readonly MemoryAsset[]): AutoVerifyResult[] {
    return created.map((asset) => this.evaluateAndTransition(scope, asset));
  }

  /** 批量复评：评估该作用域全部现存 Draft（多会话规则成熟后/事后开启规则时用）。 */
  evaluateDrafts(scope: Scope): AutoVerifyResult[] {
    return this.deps.memory.list(scope)
      .filter((asset) => asset.governance.status === "draft")
      .map((asset) => this.evaluateAndTransition(scope, asset));
  }

  private evaluateAndTransition(scope: Scope, asset: MemoryAsset): AutoVerifyResult {
    try {
      const evaluation: AutoVerifyEvaluation = evaluateAutoVerify(this.deps.config, {
        kind: "memory",
        layer: asset.layer,
        confidence: asset.governance.confidence,
        sensitivity: asset.governance.sensitivity,
        content: asset.content,
        evidence: this.sourceEvidence(scope, asset),
      });
      if (!evaluation.passed) {
        return { id: asset.id, passed: false, ruleCodes: evaluation.ruleCodes };
      }
      // 复用人工 Verify 的同一转换路径：状态机校验 + verifiedBy=auto 标记
      this.deps.memory.transition(asset.id, scope, "verified", { verifiedBy: "auto" });
      return { id: asset.id, passed: true, ruleCodes: [] };
    } catch (error) {
      // 失败安全：任何异常（证据缺失、转换冲突等）都不转换，资产留在 Draft
      return {
        id: asset.id,
        passed: false,
        ruleCodes: [],
        errorCode: error instanceof Error ? error.name : "UnknownError",
      };
    }
  }

  /** 取 Draft 的来源证据原文（严格限定作用域）：引用悬空视为无证据，交给规则否决。 */
  private sourceEvidence(scope: Scope, asset: MemoryAsset) {
    return asset.sources
      .map((source) => this.deps.repository.getEvidenceScoped(source.evidenceId, scope))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);
  }
}
