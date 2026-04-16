#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  let userAborted = false;

  process.on("SIGINT", () => { userAborted = true; });
  process.on("SIGTERM", () => { userAborted = true; });

  while (!userAborted) {
    await ensureLoggedIn();

    const agent = new AcpAgent({
      command: acpCommand,
      args: acpArgs,
      excludeMcpServers: ["relay-mcp"],
    });
    const ac = new AbortController();
    let sessionExpired = false;

    const onExit = () => {
      console.log("\n正在停止...");
      userAborted = true;
      agent.dispose();
      ac.abort();
    };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);

    try {
      await start(agent, {
        abortSignal: ac.signal,
        log: (msg) => {
          console.log(msg);
          if (!userAborted && msg.includes("session expired (errcode")) {
            sessionExpired = true;
            ac.abort();
          }
        },
      });
    } catch {
      // AbortError — handled below
    } finally {
      agent.dispose();
      process.removeListener("SIGINT", onExit);
      process.removeListener("SIGTERM", onExit);
    }

    if (userAborted || !sessionExpired) break;

    console.log("\n⚠️ 微信会话过期，正在重新登录...\n");
    await login();
  }
}

async function main() {
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgent(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgent(acpCommand);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                     使用 Claude Code
  npx weixin-acp codex                           使用 Codex
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

示例:
  npx weixin-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
