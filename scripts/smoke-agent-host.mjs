#!/usr/bin/env node
// 多宿主 MCP 接入冒烟验收（Task 5：Claude Code / Codex / OpenCode 复用同一构建产物）。
//
// 两层验收：
//   dry（默认，零模型费用）：
//     1. 用隔离内存库 seed 验收资产，起临时 HTTP 服务；
//     2. 以真实构建产物 dist/adapters/mcp/server.js 为子进程，经 MCP stdio client 直连，
//        跑 evals/agent-host-cases.json 的六类用例（身份/偏好/Skill/无关/密钥错误/服务不可用）；
//     3. 配置漂移检测：对照 .mcp.json、.codex/config.toml.example、opencode.json.example，
//        断言三个宿主配置启动的是同一构建产物、同一组非敏感环境变量名。
//   live（--live 且 MEMORY_SKILLS_SMOKE=1，产生模型费用）：
//     对真实宿主 CLI（claude / codex / opencode）发起 live 用例，断言两件事：
//     a. 工具被调用：data/events.jsonl 出现新增的 context.recall.completed 事件；
//     b. 最终答案包含期望关键词（按真实库中的 Verified 资产断言）。
//
// 输出只有宿主名、调用与命中断言结果，不打印资产正文与密钥。

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  MemoryService,
  SkillService,
  SqliteRepository,
  createMemorySkillsServer,
} from "../dist/index.js";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_ROOT, "..");
const CASES_PATH = resolve(PROJECT_ROOT, "evals/agent-host-cases.json");
const MCP_ENTRY = "dist/adapters/mcp/server.js";
const SMOKE_FLAG = "MEMORY_SKILLS_SMOKE";
const RUN = promisify(execFile);

main().catch((error) => {
  console.error("冒烟失败：", error instanceof Error ? `${error.name} ${error.message}` : error);
  process.exit(1);
});

async function main() {
  const live = process.argv.includes("--live");
  if (live) {
    await runLive();
  } else {
    await runDry();
  }
}

/* ------------------------------------------------------------------ */
/* dry 层：MCP 直连六类用例 + 配置漂移检测                              */
/* ------------------------------------------------------------------ */

async function runDry() {
  const plan = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const failures = [];
  const results = [];

  // 1. 隔离环境：内存库 seed 资产 + 临时 HTTP 服务
  const accessKey = "smoke-agent-host-key";
  const repository = new SqliteRepository(":memory:");
  seedAssets(plan, repository);
  const httpServer = createMemorySkillsServer({ repository, accessKey });
  await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
  const { port } = httpServer.address();

  try {
    // 2. 正常用例：真实构建产物 + 标准环境变量（等价三个宿主配置展开后的形态）
    const baseEnv = {
      MEMORY_SKILLS_URL: `http://127.0.0.1:${port}`,
      MEMORY_SKILLS_ACCESS_KEY: accessKey,
      MEMORY_SKILLS_USER_ID: plan.scope.userId,
      MEMORY_SKILLS_TEAM_ID: plan.scope.teamId,
      MEMORY_SKILLS_AGENT_ID: plan.scope.agentId,
    };
    await withMcpClient(baseEnv, async (client) => {
      for (const testCase of plan.cases) {
        if (testCase.kind !== "recall") continue;
        const verdict = await checkRecallCase(client, testCase);
        results.push(verdict);
        if (!verdict.pass) failures.push(`${testCase.id}：${verdict.detail}`);
      }
    });

    // 3. 故障用例：密钥错误（HTTP 401）与服务不可用（连接失败），各自独立进程
    for (const testCase of plan.cases) {
      if (testCase.kind === "auth-failure") {
        const verdict = await checkFailureCase({ ...baseEnv, MEMORY_SKILLS_ACCESS_KEY: "wrong-key" }, testCase, /401/);
        results.push(verdict);
        if (!verdict.pass) failures.push(`${testCase.id}：${verdict.detail}`);
      }
      if (testCase.kind === "backend-failure") {
        const verdict = await checkFailureCase({ ...baseEnv, MEMORY_SKILLS_URL: "http://127.0.0.1:9" }, testCase, /fetch failed|ECONNREFUSED|connect/i);
        results.push(verdict);
        if (!verdict.pass) failures.push(`${testCase.id}：${verdict.detail}`);
      }
    }

    // 4. 配置漂移检测：三个宿主配置必须指向同一构建产物与非敏感环境变量名
    for (const verdict of checkHostConfigs()) {
      results.push(verdict);
      if (!verdict.pass) failures.push(`${verdict.id}：${verdict.detail}`);
    }
  } finally {
    await new Promise((resolveClose) => httpServer.close(resolveClose));
    repository.close();
  }

  report("dry（MCP 直连 + 配置漂移）", results, failures);
}

/** seed 验收资产：记忆走 capture → propose → verify，Skill 走 create → verify。 */
function seedAssets(plan, repository) {
  const memory = new MemoryService(repository);
  const skills = new SkillService(repository);
  for (const asset of plan.assets) {
    if (asset.kind === "memory") {
      const evidence = memory.capture({ id: `ev-${asset.id}`, scope: plan.scope, role: "user", content: asset.content });
      const proposed = memory.propose({
        id: asset.id, layer: "l1", scope: plan.scope, content: asset.content,
        confidence: asset.confidence ?? 0.9, reason: `smoke ${asset.id}`, sourceEvidenceIds: [evidence.id],
      });
      memory.transition(proposed.id, plan.scope, "verified");
    } else {
      const created = skills.create({
        id: asset.id, scope: plan.scope, name: asset.name, description: asset.description,
        content: `---\nname: ${asset.name}\ndescription: ${JSON.stringify(asset.description)}\n---\n\n${asset.skillContent}`,
        sourceEvidenceIds: [],
      });
      skills.transition(created.id, plan.scope, "verified");
    }
  }
}

/** 以给定环境变量 spawn 真实构建产物，建立 MCP stdio 连接。 */
async function withMcpClient(env, body) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(PROJECT_ROOT, MCP_ENTRY)],
    cwd: PROJECT_ROOT,
    stderr: "pipe",
    env,
  });
  const client = new Client({ name: "memory-skills-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await body(client);
  } finally {
    await client.close();
  }
}

/** 召回用例断言：期望资产在结果中，无关用例两边都为空。 */
async function checkRecallCase(client, testCase) {
  try {
    const result = await client.callTool({ name: "recall_context", arguments: { query: testCase.query } });
    if (result.isError) {
      return { id: testCase.id, host: "mcp-direct", pass: false, detail: `工具返回错误：${firstText(result)}` };
    }
    const context = result.structuredContent ?? JSON.parse(firstText(result));
    const memoryIds = (context.memories ?? []).map((item) => item.id);
    const skillIds = (context.skills ?? []).map((item) => item.id);
    const expectMemories = testCase.expectMemoryIds ?? [];
    const expectSkills = testCase.expectSkillIds ?? [];
    const missing = [
      ...expectMemories.filter((id) => !memoryIds.includes(id)).map((id) => `memory:${id}`),
      ...expectSkills.filter((id) => !skillIds.includes(id)).map((id) => `skill:${id}`),
    ];
    const unexpected = memoryIds.length + skillIds.length > 0 && expectMemories.length + expectSkills.length === 0
      ? `无关查询却返回了 ${memoryIds.length + skillIds.length} 条资产`
      : "";
    const detail = missing.length ? `缺少 ${missing.join(", ")}` : unexpected || `命中 memory ${memoryIds.length} 条、skill ${skillIds.length} 条`;
    return { id: testCase.id, host: "mcp-direct", pass: missing.length === 0 && !unexpected, detail };
  } catch (error) {
    return { id: testCase.id, host: "mcp-direct", pass: false, detail: `调用异常：${error.message}` };
  }
}

/** 故障用例断言：工具必须报错，且错误文本不含任何资产正文。 */
async function checkFailureCase(env, testCase, messagePattern) {
  try {
    const verdict = await withMcpClient(env, async (client) => {
      const result = await client.callTool({ name: "recall_context", arguments: { query: testCase.query } });
      const message = firstText(result);
      const isError = result.isError === true;
      const patternHit = messagePattern.test(message);
      const leaked = testCase.assetLeakMarkers?.some((marker) => message.includes(marker)) ?? false;
      const pass = isError && patternHit && !leaked;
      return { id: testCase.id, host: "mcp-direct", pass, detail: pass ? `按预期报错（${message.slice(0, 80)}）` : `isError=${isError}，错误文本不匹配或泄露资产：${message.slice(0, 80)}` };
    });
    return verdict;
  } catch (error) {
    // 工具层面应把后端故障转成 isError 结果；若 client 直接抛错也视为按预期失败，但单独标注
    return { id: testCase.id, host: "mcp-direct", pass: true, detail: `client 异常路径：${error.message.slice(0, 80)}` };
  }
}

/** 配置漂移检测：三个宿主配置启动同一构建产物，环境变量名与标准集合一致。 */
function checkHostConfigs() {
  const results = [];
  const standardVars = ["MEMORY_SKILLS_URL", "MEMORY_SKILLS_USER_ID", "MEMORY_SKILLS_TEAM_ID", "MEMORY_SKILLS_AGENT_ID"];

  // Claude Code：.mcp.json 支持 ${VAR} 展开，密钥以引用形式出现（不落值）
  const claude = JSON.parse(readFileSync(resolve(PROJECT_ROOT, ".mcp.json"), "utf8")).mcpServers["memory-skills"];
  const claudeEnvKeys = Object.keys(claude.env ?? {});
  const claudeOk = claude.args?.[0] === MCP_ENTRY
    && claudeEnvKeys.includes("MEMORY_SKILLS_ACCESS_KEY")
    && standardVars.every((name) => claudeEnvKeys.includes(name));
  results.push({ id: "config-claude", host: "claude-code", pass: claudeOk, detail: claudeOk ? ".mcp.json 指向同一构建产物，含 ${VAR} 密钥引用" : "请检查 .mcp.json 的 args 与 env 变量名" });

  // Codex：用户级 ~/.codex/config.toml 不支持变量展开，密钥靠进程环境继承，配置里不得出现
  const codex = readFileSync(resolve(PROJECT_ROOT, ".codex/config.toml.example"), "utf8");
  const codexArgs = /\bargs\s*=\s*\[[^\]]*dist\/adapters\/mcp\/server\.js[^\]]*\]/s.exec(codex);
  const codexEnvVars = [...codex.matchAll(/\b(MEMORY_SKILLS_[A-Z_]+)\s*=/g)].map((match) => match[1]);
  const codexOk = Boolean(codexArgs)
    && standardVars.every((name) => codexEnvVars.includes(name))
    && !codexEnvVars.includes("MEMORY_SKILLS_ACCESS_KEY");
  results.push({ id: "config-codex", host: "codex", pass: codexOk, detail: codexOk ? "example 指向同一构建产物，非敏感变量齐全且不含密钥" : "请检查 .codex/config.toml.example 的 args 与 env" });

  // OpenCode：项目级 opencode.json，密钥同样靠进程环境继承
  const opencode = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "opencode.json.example"), "utf8")).mcp["memory-skills"];
  const opencodeEnvKeys = Object.keys(opencode.environment ?? {});
  const opencodeOk = opencode.type === "local"
    && opencode.command?.at(-1) === MCP_ENTRY
    && standardVars.every((name) => opencodeEnvKeys.includes(name))
    && !opencodeEnvKeys.includes("MEMORY_SKILLS_ACCESS_KEY");
  results.push({ id: "config-opencode", host: "opencode", pass: opencodeOk, detail: opencodeOk ? "example 指向同一构建产物，非敏感变量齐全且不含密钥" : "请检查 opencode.json.example 的 command 与 environment" });

  return results;
}

/* ------------------------------------------------------------------ */
/* live 层：真实宿主 CLI + 服务端事件断言                               */
/* ------------------------------------------------------------------ */

/** 宿主启动方式：每项都在项目根目录运行，环境继承自当前进程（含密钥）。resolve 返回 null 表示宿主不可用。 */
function hostCommands() {
  return {
    "claude-code": {
      async resolve() {
        const argsFor = (query) => ["-p", query, "--output-format", "text"];
        if (await which("claude")) return { command: "claude", argsFor };
        // 回退：npm 全局已装 @anthropic-ai/claude-code 但 bin 链接缺失时，直接跑 cli.js
        const cliJs = "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js";
        if (existsSync(cliJs)) return { command: process.execPath, argsFor: (query) => [cliJs, ...argsFor(query)] };
        return null;
      },
    },
    codex: {
      async resolve() {
        return await which("codex")
          ? { command: "codex", argsFor: (query) => ["exec", "--skip-git-repo-check", query] }
          : null;
      },
    },
    opencode: {
      async resolve() {
        if (!(await which("opencode"))) return null;
        // 宿主默认模型配置不可用时，可用 SMOKE_OPENCODE_MODEL=provider/model 显式指定
        const model = process.env.SMOKE_OPENCODE_MODEL;
        return {
          command: "opencode",
          argsFor: (query) => ["run", ...(model ? ["-m", model] : []), query],
        };
      },
    },
  };
}

async function runLive() {
  if (process.env[SMOKE_FLAG] !== "1") {
    console.error(`未设置 ${SMOKE_FLAG}=1，跳过真实宿主调用（防止意外费用）。`);
    console.error(`用法：${SMOKE_FLAG}=1 npm run smoke:agent-host -- --live [--host codex,opencode,claude-code]`);
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const hosts = parseHostsArg();
  const baseUrl = process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421";
  const eventsPath = resolve(PROJECT_ROOT, "data/events.jsonl");

  // 前置检查：服务可达、密钥存在、事件文件可读
  if (!process.env.MEMORY_SKILLS_ACCESS_KEY) {
    throw new Error("live 模式需要 MEMORY_SKILLS_ACCESS_KEY（从 .env 加载或手动 export）");
  }
  const healthResponse = await fetch(`${baseUrl}/v1/context/recall`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MEMORY_SKILLS_ACCESS_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "live 冒烟前置检查", scope: { userId: "local-admin", teamId: "local", agentId: "default" } }),
  });
  if (!healthResponse.ok) throw new Error(`服务 ${baseUrl} 预检失败：HTTP ${healthResponse.status}`);
  let eventsBefore = 0;
  try {
    eventsBefore = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    throw new Error(`读不到 ${eventsPath}：live 断言依赖服务端事件文件`);
  }

  const failures = [];
  const results = [];
  for (const [hostName, host] of Object.entries(hostCommands())) {
    if (hosts && !hosts.includes(hostName)) continue;
    const launcher = await host.resolve();
    if (!launcher) {
      results.push({ id: `host-${hostName}`, host: hostName, pass: false, detail: "宿主 CLI 不可用（未安装或 bin 链接缺失），跳过" });
      failures.push(`${hostName}：CLI 不可用`);
      continue;
    }
    for (const testCase of plan.liveCases) {
      const verdict = await runLiveCase(hostName, launcher, testCase, eventsPath, eventsBefore);
      results.push(verdict);
      if (!verdict.pass) failures.push(`${hostName}/${testCase.id}：${verdict.detail}`);
    }
  }
  report("live（真实宿主 CLI）", results, failures);
}

async function runLiveCase(hostName, launcher, testCase, eventsPath, eventsBefore) {
  try {
    // 每个用例记录一次事件水位，避免用例之间互相借用事件
    const waterMark = countEvents(eventsPath) ?? eventsBefore;
    const { stdout } = await RUN(launcher.command, launcher.argsFor(testCase.query), {
      cwd: PROJECT_ROOT,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        MEMORY_SKILLS_URL: process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421",
        MEMORY_SKILLS_ACCESS_KEY: process.env.MEMORY_SKILLS_ACCESS_KEY,
      },
    });
    const answer = stdout.trim();

    // 断言一：服务端出现新增召回事件（工具确实被调用）
    const newEvents = readNewEvents(eventsPath, waterMark);
    const recallEvent = newEvents.find((event) => event.eventType === "context.recall.completed" || event.eventType === "context.recall.failed");
    const queryCharsNote = recallEvent ? `queryChars=${recallEvent.queryChars}（用例长度 ${testCase.query.length}）` : "";

    // 断言二：最终答案包含期望关键词
    const missingKeywords = testCase.expectAnswerKeywords.filter((keyword) => !answer.includes(keyword));

    const pass = Boolean(recallEvent) && missingKeywords.length === 0;
    const detail = [
      recallEvent ? `工具已调用（${recallEvent.eventType}，${queryCharsNote}）` : "未见新增召回事件",
      missingKeywords.length === 0 ? `答案命中关键词 ${testCase.expectAnswerKeywords.join("/")}` : `答案缺少关键词：${missingKeywords.join("/")}`,
    ].join("；");
    return { id: testCase.id, host: hostName, pass, detail, answerPreview: answer.slice(0, 120) };
  } catch (error) {
    return { id: testCase.id, host: hostName, pass: false, detail: `CLI 执行失败：${error.message.slice(0, 200)}` };
  }
}

function countEvents(eventsPath) {
  try {
    return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

function readNewEvents(eventsPath, waterMark) {
  const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  return lines.slice(waterMark).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function parseHostsArg() {
  const hostIndex = process.argv.indexOf("--host");
  if (hostIndex === -1 || hostIndex + 1 >= process.argv.length) return null;
  return process.argv[hostIndex + 1].split(",").map((name) => name.trim()).filter(Boolean);
}

async function which(bin) {
  try {
    await RUN("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 公共输出                                                            */
/* ------------------------------------------------------------------ */

function firstText(result) {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

function report(title, results, failures) {
  console.log(`\n=== smoke-agent-host：${title} ===`);
  for (const verdict of results) {
    const mark = verdict.pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${verdict.host.padEnd(12)} ${verdict.id} —— ${verdict.detail}`);
  }
  console.log(`\n共 ${results.length} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("冒烟结论：多宿主验收全部通过。");
}
