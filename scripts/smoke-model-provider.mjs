#!/usr/bin/env node
// 模型 Provider 真实调用冒烟脚本（Task 8）。
// 安全约束：必须显式设置 MEMORY_SKILLS_SMOKE=1 才会调用真实模型 API，避免意外产生费用；
// 输出只包含结构化结果、用量与指标摘要，不打印 Prompt/Response 完整正文与密钥。

import { z } from "zod";

import {
  InMemoryLlmMetricsRecorder,
  createLlmProvider,
  describeLlmConfig,
  resolveLlmConfigFromEnv,
} from "../dist/index.js";

const SMOKE_FLAG = "MEMORY_SKILLS_SMOKE";
const SCHEMA = z.object({
  preferences: z.array(z.object({
    topic: z.string(),
    content: z.string(),
  })),
});

async function main() {
  if (process.env[SMOKE_FLAG] !== "1") {
    console.error(`未设置 ${SMOKE_FLAG}=1，跳过真实模型调用（防止意外费用）。`);
    console.error(`用法：${SMOKE_FLAG}=1 npm run smoke:model-provider`);
    process.exit(1);
  }

  const config = resolveLlmConfigFromEnv(process.env);
  const metrics = new InMemoryLlmMetricsRecorder();
  // mock 模式给固定脚本：允许在无密钥环境完整验证调用链路（不产生费用）
  const mockSteps = config.provider === "mock"
    ? [{
        type: "ok",
        data: {
          preferences: [
            { topic: "语言", content: "注释与文档使用中文" },
            { topic: "部署", content: "先在本地验证，不直接改动线上" },
          ],
        },
      }]
    : undefined;
  const provider = createLlmProvider(config, { metrics, mockSteps });

  console.log("Provider 配置：", JSON.stringify(describeLlmConfig(config)));

  const response = await provider.structured({
    task: "smoke-model-provider",
    systemPrompt: "从对话内容中提取用户的稳定偏好，忽略一次性陈述。每个偏好给出主题与具体内容。",
    userContent: [
      "以下是一段对话记录：",
      "用户：以后注释和文档都用中文写，我读起来更快。",
      "用户：另外部署相关的操作先在本地验证，不要直接动线上。",
      "用户：今天中午吃了拉面。（与偏好无关）",
    ].join("\n"),
    schemaName: "preferences",
    schema: SCHEMA,
  });

  console.log("结构化输出：", JSON.stringify(response.data, null, 2));
  console.log("模型：", response.model);
  console.log("用量：", JSON.stringify(response.usage));
  console.log("尝试次数：", response.attempts, "；耗时(ms)：", response.latencyMs);
  console.log("指标摘要：", JSON.stringify(metrics.summary()));

  const parsed = SCHEMA.parse(response.data);
  if (!Array.isArray(parsed.preferences) || parsed.preferences.length === 0) {
    throw new Error("冒烟失败：模型未提取出任何偏好");
  }
  console.log("冒烟通过。");
}

main().catch((error) => {
  console.error("冒烟失败：", error instanceof Error ? `${error.name} ${error.message}` : error);
  process.exit(1);
});
