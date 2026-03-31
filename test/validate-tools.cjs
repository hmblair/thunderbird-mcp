#!/usr/bin/env node
/**
 * Validate tools.json: well-formed JSON, every tool has name + inputSchema,
 * no duplicate names, bridge TOOL_GROUPS reference only defined tools.
 */
const fs = require("fs");
const path = require("path");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const toolsPath = path.join(__dirname, "..", "extension", "mcp_server", "tools.json");
const tools = JSON.parse(fs.readFileSync(toolsPath, "utf8"));
assert(Array.isArray(tools), "tools.json is not an array");

const names = new Set();
for (const tool of tools) {
  assert(tool.name, `Tool missing name: ${JSON.stringify(tool).slice(0, 80)}`);
  assert(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`);
  assert(tool.inputSchema.type === "object", `Tool "${tool.name}" inputSchema.type is not "object"`);
  assert(!names.has(tool.name), `Duplicate tool name: "${tool.name}"`);
  names.add(tool.name);
}

// Validate bridge TOOL_GROUPS reference only tools that exist
const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "mcp-bridge.cjs"), "utf8");
const groupsMatch = bridgeSrc.match(/const TOOL_GROUPS = \{([\s\S]*?)\};/);
assert(groupsMatch, "Could not find TOOL_GROUPS in mcp-bridge.cjs");
const groupToolNames = [...groupsMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
// Filter out group keys (mail, calendar, feeds)
const groupKeys = new Set(["mail", "calendar", "feeds"]);
const referencedTools = groupToolNames.filter((n) => !groupKeys.has(n));
for (const name of referencedTools) {
  assert(names.has(name), `TOOL_GROUPS references unknown tool: "${name}"`);
}

console.log(`OK: ${tools.length} tools validated, ${referencedTools.length} group references checked`);
