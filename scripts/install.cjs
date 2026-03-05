#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const bridgePath = path.resolve(__dirname, "..", "mcp-bridge.cjs");
const home = process.env.HOME || process.env.USERPROFILE;

const CLAUDE_CONFIG = path.join(home, ".mcp.json");
const OPENCODE_CONFIG = path.join(home, ".config", "opencode", "opencode.json");

const TOOL_GROUPS = ["mail", "calendar", "feeds"];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

let rl;

function ask(question) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}

function installClaude() {
  const config = readJson(CLAUDE_CONFIG) || {};
  if (!config.mcpServers) config.mcpServers = {};
  for (const group of TOOL_GROUPS) {
    config.mcpServers[`thunderbird-${group}`] = {
      command: "node",
      args: [bridgePath, `--tools=${group}`],
    };
  }
  writeJson(CLAUDE_CONFIG, config);
  const names = TOOL_GROUPS.map((g) => `thunderbird-${g}`).join(", ");
  console.log(`  Added ${names} to ${CLAUDE_CONFIG}`);
}

function installOpencode() {
  const config = readJson(OPENCODE_CONFIG) || { $schema: "https://opencode.ai/config.json" };
  if (!config.mcp) config.mcp = {};
  for (const group of TOOL_GROUPS) {
    config.mcp[`thunderbird-${group}`] = {
      type: "local",
      command: ["node", bridgePath, `--tools=${group}`],
    };
  }
  writeJson(OPENCODE_CONFIG, config);
  const names = TOOL_GROUPS.map((g) => `thunderbird-${g}`).join(", ");
  console.log(`  Added ${names} to ${OPENCODE_CONFIG}`);
}

function uninstallClaude() {
  const config = readJson(CLAUDE_CONFIG);
  if (!config?.mcpServers) return;
  let removed = [];
  for (const group of TOOL_GROUPS) {
    const key = `thunderbird-${group}`;
    if (config.mcpServers[key]) {
      delete config.mcpServers[key];
      removed.push(key);
    }
  }
  if (removed.length) {
    writeJson(CLAUDE_CONFIG, config);
    console.log(`  Removed ${removed.join(", ")} from ${CLAUDE_CONFIG}`);
  }
}

function uninstallOpencode() {
  const config = readJson(OPENCODE_CONFIG);
  if (!config?.mcp) return;
  let removed = [];
  for (const group of TOOL_GROUPS) {
    const key = `thunderbird-${group}`;
    if (config.mcp[key]) {
      delete config.mcp[key];
      removed.push(key);
    }
  }
  if (removed.length) {
    writeJson(OPENCODE_CONFIG, config);
    console.log(`  Removed ${removed.join(", ")} from ${OPENCODE_CONFIG}`);
  }
}

async function install() {
  console.log();
  if (await ask("Install into Claude Code (~/.mcp.json)? [Y/n] ")) {
    installClaude();
  } else {
    console.log("  Skipped.");
  }
  console.log();
  if (await ask("Install into OpenCode (~/.config/opencode/opencode.json)? [Y/n] ")) {
    installOpencode();
  } else {
    console.log("  Skipped.");
  }
  console.log();
  rl.close();
}

function uninstall() {
  console.log();
  uninstallClaude();
  uninstallOpencode();
  console.log();
}

const command = process.argv[2];
if (command === "uninstall") {
  uninstall();
} else {
  install();
}
