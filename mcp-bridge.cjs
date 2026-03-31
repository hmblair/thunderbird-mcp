#!/usr/bin/env node
/**
 * MCP Bridge for Thunderbird
 *
 * Converts stdio MCP protocol to HTTP requests for the Thunderbird MCP extension.
 * The extension exposes an HTTP endpoint on localhost:8765.
 */

const http = require('http');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const portArg = process.argv.find(a => a.startsWith('--port='));
const timeoutArg = process.argv.find(a => a.startsWith('--timeout='));
const THUNDERBIRD_PORT = portArg ? parseInt(portArg.slice('--port='.length), 10) : 8765;
const REQUEST_TIMEOUT = timeoutArg ? parseInt(timeoutArg.slice('--timeout='.length), 10) : 120000;
const TOKEN_PATH = path.join(os.homedir(), '.thunderbird-mcp-token');
const VERSION = require(path.join(__dirname, 'package.json')).version;

/**
 * Tool group definitions. Use --tools=group1,group2 to expose only specific
 * groups. Default is all tools. Available groups: mail, calendar, feeds.
 */
const TOOL_GROUPS = {
  mail: [
    'listAccounts', 'listFolders', 'searchMessages', 'getThread',
    'deleteMessages', 'deleteMessagesBySender', 'updateMessages', 'getNewMail', 'unsubscribe', 'createDraft', 'sendDraft', 'searchContacts',
    'createFolder', 'renameFolder', 'deleteFolder', 'moveFolder',
    'emptyJunk', 'emptyTrash',
  ],
  calendar: [
    'listCalendars', 'createEvent', 'listEvents', 'updateEvent', 'deleteEvent', 'moveEvent',
    'listTasks', 'createTask', 'updateTask', 'deleteTask', 'moveTask',
  ],
  feeds: [
    'listAccounts', 'createFeedAccount', 'listFeeds',
    'subscribeFeed', 'unsubscribeFeed', 'refreshFeeds',
    'createFolder', 'listFolders', 'searchMessages', 'getThread',
  ],
};

/**
 * Tool definitions loaded from shared JSON file.
 * Serves tools/list locally so it succeeds even when Thunderbird is not running.
 */
const ALL_TOOLS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'extension', 'mcp_server', 'tools.json'), 'utf8')
);

// Parse --tools flag to filter exposed tools
const toolsArg = process.argv.find(a => a.startsWith('--tools='));
let TOOLS;
if (toolsArg) {
  const groups = toolsArg.slice('--tools='.length).split(',').map(g => g.trim());
  const allowedNames = new Set();
  for (const group of groups) {
    const names = TOOL_GROUPS[group];
    if (!names) {
      process.stderr.write(`Unknown tool group: "${group}". Available: ${Object.keys(TOOL_GROUPS).join(', ')}\n`);
      process.exit(1);
    }
    for (const n of names) allowedNames.add(n);
  }
  TOOLS = ALL_TOOLS.filter(t => allowedNames.has(t.name));
} else {
  TOOLS = ALL_TOOLS;
}

// Strip internal-only parameters (e.g. accountTypes) from tool schemas
// so LLM clients never see or attempt to use them.
const INTERNAL_PARAMS = new Set(['accountTypes']);
const TOOLS_PUBLIC = TOOLS.map(t => {
  const props = t.inputSchema?.properties;
  if (!props) return t;
  const hasInternal = Object.keys(props).some(k => INTERNAL_PARAMS.has(k));
  if (!hasInternal) return t;
  const filtered = { ...props };
  for (const k of INTERNAL_PARAMS) delete filtered[k];
  return {
    ...t,
    inputSchema: { ...t.inputSchema, properties: filtered }
  };
});

const TOOL_NAME_SET = new Set(TOOLS.map(t => t.name));

/**
 * Account type filters per tool group. When a group is active, tools that
 * accept accountTypes will have it auto-injected so results are scoped
 * to the relevant account types. Transparent to the AI caller.
 */
const GROUP_ACCOUNT_TYPES = {
  mail: ['imap', 'ews', 'pop3', 'none'],
  feeds: ['rss'],
};
const ACCOUNT_TYPE_TOOLS = new Set(['listAccounts', 'listFolders', 'searchMessages']);

let activeAccountTypes = null;
if (toolsArg) {
  const groups = toolsArg.slice('--tools='.length).split(',').map(g => g.trim());
  // Merge account types from all active groups
  const merged = new Set();
  let hasFilter = false;
  for (const group of groups) {
    const types = GROUP_ACCOUNT_TYPES[group];
    if (types) {
      hasFilter = true;
      for (const t of types) merged.add(t);
    }
  }
  if (hasFilter) activeAccountTypes = [...merged];
}

/**
 * Read the auth token fresh each call to handle Thunderbird restarts.
 */
function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return ''; }
}

// Ensure stdout doesn't buffer - critical for MCP protocol
if (process.stdout._handle?.setBlocking) {
  process.stdout._handle.setBlocking(true);
}

let pendingRequests = 0;
let stdinClosed = false;

function checkExit() {
  if (stdinClosed && pendingRequests === 0) {
    process.exit(0);
  }
}

// Write with backpressure handling
function writeOutput(data) {
  return new Promise((resolve) => {
    if (process.stdout.write(data)) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
    }
  });
}

/**
 * Sanitize JSON response that may contain invalid control characters.
 * Email bodies often contain raw control chars that break JSON parsing.
 * api.js now pre-encodes non-ASCII for Thunderbird's raw-byte HTTP writer;
 * this remains a fallback for malformed responses.
 */
function sanitizeJson(data) {
  // Remove control chars except \n, \r, \t
  let sanitized = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Escape raw newlines/carriage returns/tabs that aren't already escaped
  sanitized = sanitized.replace(/(?<!\\)\r/g, '\\r');
  sanitized = sanitized.replace(/(?<!\\)\n/g, '\\n');
  sanitized = sanitized.replace(/(?<!\\)\t/g, '\\t');
  return sanitized;
}

async function handleMessage(line) {
  let message = JSON.parse(line);
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const isNotification =
    !hasId ||
    (typeof message.method === 'string' && message.method.startsWith('notifications/'));

  if (isNotification) {
    return null;
  }

  // Handle MCP protocol methods locally so the server configures
  // successfully even when Thunderbird is not running.
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'thunderbird-mcp', version: VERSION }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: TOOLS_PUBLIC }
      };

    case 'resources/list':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { resources: [] }
      };

    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { prompts: [] }
      };

    case 'tools/call':
      // Reject tools outside the allowed set
      if (message.params?.name && !TOOL_NAME_SET.has(message.params.name)) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Tool not available: ${message.params.name}` }
        };
      }
      // Auto-inject accountTypes filter for scoped tool groups
      if (activeAccountTypes && ACCOUNT_TYPE_TOOLS.has(message.params.name)) {
        message = JSON.parse(JSON.stringify(message));
        if (!message.params.arguments) message.params.arguments = {};
        if (!message.params.arguments.accountTypes) {
          message.params.arguments.accountTypes = activeAccountTypes;
        }
      }
      // Forward to Thunderbird, but gracefully handle connection failures
      try {
        return await forwardToThunderbird(message);
      } catch {
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{
              type: 'text',
              text: 'Thunderbird is not running. The user must have Thunderbird open with the thunderbird-mcp extension installed for this tool to work.'
            }],
            isError: true
          }
        };
      }

    default:
      return forwardToThunderbird(message);
  }
}

function forwardToThunderbird(message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(message);

    const req = http.request({
      hostname: 'localhost',
      port: THUNDERBIRD_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${readToken()}`
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(data));
        } catch {
          // Thunderbird may return JSON with invalid control chars in email content
          try {
            resolve(JSON.parse(sanitizeJson(data)));
          } catch (e) {
            reject(new Error(`Invalid JSON from Thunderbird: ${e.message}`));
          }
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Connection failed: ${e.message}. Is Thunderbird running with the MCP extension?`));
    });

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request to Thunderbird timed out'));
    });

    req.write(postData);
    req.end();
  });
}

// Process stdin as JSON-RPC messages
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let messageId = null;
  try {
    messageId = JSON.parse(line).id ?? null;
  } catch {
    // Leave as null when request cannot be parsed
  }

  pendingRequests++;
  handleMessage(line)
    .then(async (response) => {
      if (response !== null) {
        await writeOutput(JSON.stringify(response) + '\n');
      }
    })
    .catch(async (err) => {
      await writeOutput(JSON.stringify({
        jsonrpc: '2.0',
        id: messageId,
        error: { code: -32700, message: `Bridge error: ${err.message}` }
      }) + '\n');
    })
    .finally(() => {
      pendingRequests--;
      checkExit();
    });
});

rl.on('close', () => {
  stdinClosed = true;
  checkExit();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
