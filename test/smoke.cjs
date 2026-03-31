#!/usr/bin/env node
/**
 * Smoke test: spawn the bridge, send initialize + tools/list, assert responses.
 */
const { spawn } = require("child_process");
const path = require("path");

const bridge = spawn("node", [path.join(__dirname, "..", "mcp-bridge.cjs")], {
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let buffer = "";

bridge.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (line.trim()) responses.push(JSON.parse(line));
  }
});

bridge.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function send(obj) {
  bridge.stdin.write(JSON.stringify(obj) + "\n");
}

function assert(cond, msg) {
  if (!cond) {
    bridge.kill();
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

setTimeout(() => {
  bridge.stdin.end();

  assert(responses.length >= 2, `Expected 2 responses, got ${responses.length}`);

  // Check initialize
  const init = responses.find((r) => r.id === 1);
  assert(init, "No initialize response");
  assert(init.result, "Initialize has no result");
  assert(init.result.protocolVersion === "2024-11-05", `Bad protocol version: ${init.result.protocolVersion}`);
  assert(init.result.serverInfo?.name === "thunderbird-mcp", `Bad server name: ${init.result.serverInfo?.name}`);

  // Check tools/list
  const toolsList = responses.find((r) => r.id === 2);
  assert(toolsList, "No tools/list response");
  assert(Array.isArray(toolsList.result?.tools), "tools is not an array");
  assert(toolsList.result.tools.length > 0, "No tools returned");

  // Verify internal params are stripped
  for (const tool of toolsList.result.tools) {
    const props = tool.inputSchema?.properties || {};
    assert(!props.accountTypes, `Tool "${tool.name}" leaks internal accountTypes param`);
  }

  // Verify every tool has required fields
  for (const tool of toolsList.result.tools) {
    assert(tool.name, "Tool missing name");
    assert(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`);
  }

  console.log(`OK: ${responses.length} responses, ${toolsList.result.tools.length} tools, no internal params leaked`);
  process.exit(0);
}, 1000);
