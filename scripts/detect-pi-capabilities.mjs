#!/usr/bin/env node
// Pi 能力探测脚本（Task 6）：核对"Pi 是否原生支持 stdio MCP"这一前提。
// 零费用：只做本机 CLI 探测，不调用模型、不联网。
//
// 背景（2026-08-21 核实 pi.dev 官网）：Pi 官方把 "No MCP" 列为刻意的设计取舍，
// MCP 集成属于扩展层能力而非内置能力。本脚本探测本机 Pi 的实际状态，
// 结论用于续期 docs/spikes/pi-integration-decision.md 中的适配决策。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const RUN = promisify(execFile);
/** Pi 官方 npm 包与 CLI 名（来源：pi.dev 首页安装说明）。 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_BIN = "pi";

main().catch((error) => {
  console.error("探测失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  console.log(`Pi 能力探测（${new Date().toISOString().slice(0, 10)}）`);
  console.log(`官方包：${PI_PACKAGE}，CLI：${PI_BIN}\n`);

  const installed = await binExists(PI_BIN);
  if (!installed) {
    console.log("[结论] 本机未安装 Pi。");
    console.log("       官方现状（pi.dev 核实）：No MCP 是刻意设计，MCP 属于扩展层能力。");
    console.log(`       安装后重跑本脚本复核：npm install -g --ignore-scripts ${PI_PACKAGE}`);
    console.log("       适配决策见 docs/spikes/pi-integration-decision.md。");
    return;
  }

  // 已安装：收集版本、子命令与 MCP 关键字，判断是否原生支持 MCP
  const version = await safeRun(PI_BIN, ["--version"]);
  console.log(`[版本] ${version ?? "未知"}`);

  const help = await safeRun(PI_BIN, ["--help"]);
  if (help) {
    const mcpLines = help.split(/\r?\n/).filter((line) => /mcp/i.test(line));
    console.log(mcpLines.length > 0
      ? `[线索] --help 中出现 MCP 关键字：\n${mcpLines.map((line) => `  ${line.trim()}`).join("\n")}`
      : "[线索] --help 中未出现 MCP 关键字");
  } else {
    console.log("[线索] 无法获取 --help 输出");
  }

  const subcommands = ["mcp", "extensions", "install"];
  for (const sub of subcommands) {
    const output = await safeRun(PI_BIN, [sub, "--help"]);
    console.log(output ? `[子命令] pi ${sub}：存在` : `[子命令] pi ${sub}：不存在`);
  }

  console.log("\n[判断] 若上方无 MCP 线索，维持决策：Pi 暂不接入，等待官方 MCP 支持或装机后评估扩展注入方案。");
  console.log("       适配决策见 docs/spikes/pi-integration-decision.md。");
}

async function binExists(bin) {
  try {
    await RUN("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

/** 运行命令，失败返回 null（探测类脚本不因单条命令失败而中断）。 */
async function safeRun(bin, args) {
  try {
    const { stdout, stderr } = await RUN(bin, args, { timeout: 20_000 });
    return (stdout || stderr).trim();
  } catch (error) {
    const output = error.stdout ?? error.stderr;
    return typeof output === "string" && output.trim() ? output.trim() : null;
  }
}
