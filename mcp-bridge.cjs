#!/usr/bin/env node
/**
 * MCP Bridge for Thunderbird
 *
 * Converts stdio MCP protocol to HTTP requests for the Thunderbird MCP extension.
 * The extension exposes an HTTP endpoint on localhost:8765.
 */

const http = require('http');
const readline = require('readline');

const THUNDERBIRD_PORT = 8765;
const REQUEST_TIMEOUT = 30000;

/**
 * Tool definitions served locally by the bridge.
 * These mirror the tools registered in extension/mcp_server/api.js so that
 * tools/list succeeds even when Thunderbird is not running.
 */
const TOOLS = [
  {
    name: "listAccounts",
    description: "List all email accounts and their identities",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "listFolders",
    description: "List all mail folders with URIs and message counts",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Optional account ID (from listAccounts) to limit results to a single account" },
        folderPath: { type: "string", description: "Optional folder URI to list only that folder and its subfolders" },
      },
      required: [],
    },
  },
  {
    name: "searchMessages",
    description: "Search message headers and return IDs/folder paths you can use with getMessage to read full email content",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in subject, author, or recipients (use empty string to match all)" },
        folderPath: { type: "string", description: "Optional folder URI to limit search to that folder and its subfolders" },
        startDate: { type: "string", description: "Filter messages on or after this ISO 8601 date" },
        endDate: { type: "string", description: "Filter messages on or before this ISO 8601 date" },
        maxResults: { type: "number", description: "Maximum number of results to return (default 50, max 200)" },
        sortOrder: { type: "string", description: "Date sort order: asc (oldest first) or desc (newest first, default)" },
        unreadOnly: { type: "boolean", description: "Only return unread messages (default: false)" },
        flaggedOnly: { type: "boolean", description: "Only return flagged/starred messages (default: false)" },
      },
      required: ["query"],
    },
  },
  {
    name: "getMessage",
    description: "Read the full content of an email message by its ID",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message ID (from searchMessages results)" },
        folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
        saveAttachments: { type: "boolean", description: "If true, save attachments to /tmp/thunderbird-mcp/<messageId>/ and include filePath in response (default: false)" },
      },
      required: ["messageId", "folderPath"],
    },
  },
  {
    name: "sendMail",
    description: "Open a compose window with pre-filled recipient, subject, and body for user review before sending",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
        from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
        attachments: { type: "array", items: { type: "string" }, description: "Array of file paths to attach" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "listCalendars",
    description: "Return the user's calendars",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "createEvent",
    description: "Create a calendar event. By default opens a review dialog; set skipReview to add directly.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        startDate: { type: "string", description: "Start date/time in ISO 8601 format" },
        endDate: { type: "string", description: "End date/time in ISO 8601 (defaults to startDate + 1h for timed, +1 day for all-day)" },
        location: { type: "string", description: "Event location" },
        description: { type: "string", description: "Event description" },
        calendarId: { type: "string", description: "Target calendar ID (from listCalendars, defaults to first writable calendar)" },
        allDay: { type: "boolean", description: "Create an all-day event (default: false)" },
        skipReview: { type: "boolean", description: "If true, add the event directly without opening a review dialog (default: false)" },
      },
      required: ["title", "startDate"],
    },
  },
  {
    name: "listEvents",
    description: "List calendar events within a date range",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID to query (from listCalendars). If omitted, queries all calendars." },
        startDate: { type: "string", description: "Start of date range in ISO 8601 format (default: now)" },
        endDate: { type: "string", description: "End of date range in ISO 8601 format (default: 30 days from startDate)" },
        maxResults: { type: "number", description: "Maximum number of events to return (default: 100)" },
      },
      required: [],
    },
  },
  {
    name: "updateEvent",
    description: "Update an existing calendar event's title, dates, location, or description",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID (from listEvents results)" },
        calendarId: { type: "string", description: "The calendar ID containing the event (from listEvents results)" },
        title: { type: "string", description: "New event title (optional)" },
        startDate: { type: "string", description: "New start date/time in ISO 8601 format (optional)" },
        endDate: { type: "string", description: "New end date/time in ISO 8601 format (optional)" },
        location: { type: "string", description: "New event location (optional)" },
        description: { type: "string", description: "New event description (optional)" },
      },
      required: ["eventId", "calendarId"],
    },
  },
  {
    name: "deleteEvent",
    description: "Delete a calendar event",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID (from listEvents results)" },
        calendarId: { type: "string", description: "The calendar ID containing the event (from listEvents results)" },
      },
      required: ["eventId", "calendarId"],
    },
  },
  {
    name: "searchContacts",
    description: "Find contacts the user interacted with",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Email address or name to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "replyToMessage",
    description: "Open a reply compose window for a specific message with proper threading",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message ID to reply to (from searchMessages results)" },
        folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
        body: { type: "string", description: "Reply body text" },
        replyAll: { type: "boolean", description: "Reply to all recipients (default: false)" },
        isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
        to: { type: "string", description: "Override recipient email (default: original sender)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
        attachments: { type: "array", items: { type: "string" }, description: "Array of file paths to attach" },
      },
      required: ["messageId", "folderPath", "body"],
    },
  },
  {
    name: "forwardMessage",
    description: "Open a forward compose window for a message with attachments preserved",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message ID to forward (from searchMessages results)" },
        folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
        to: { type: "string", description: "Recipient email address" },
        body: { type: "string", description: "Additional text to prepend (optional)" },
        isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
        attachments: { type: "array", items: { type: "string" }, description: "Array of additional file paths to attach" },
      },
      required: ["messageId", "folderPath", "to"],
    },
  },
  {
    name: "getRecentMessages",
    description: "Get recent messages from a specific folder or all folders, with date and unread filtering",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "Folder URI to list messages from (defaults to all Inboxes)" },
        daysBack: { type: "number", description: "Only return messages from the last N days (default: 7)" },
        maxResults: { type: "number", description: "Maximum number of results (default: 50, max: 200)" },
        unreadOnly: { type: "boolean", description: "Only return unread messages (default: false)" },
        flaggedOnly: { type: "boolean", description: "Only return flagged/starred messages (default: false)" },
      },
      required: [],
    },
  },
  {
    name: "deleteMessages",
    description: "Delete messages from a folder. Drafts are moved to Trash instead of permanently deleted.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: { type: "array", items: { type: "string" }, description: "Array of message IDs to delete" },
        folderPath: { type: "string", description: "The folder URI containing the messages" },
      },
      required: ["messageIds", "folderPath"],
    },
  },
  {
    name: "updateMessage",
    description: "Update one or more messages' read/flagged state and optionally move them to another folder or to Trash. Supply messageId for a single message or messageIds for bulk operations.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "A single message ID (from searchMessages results). Use messageId or messageIds, not both." },
        messageIds: { type: "array", items: { type: "string" }, description: "Array of message IDs for bulk operations. Use messageId or messageIds, not both." },
        folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
        read: { type: "boolean", description: "Set to true/false to mark read/unread (optional)" },
        flagged: { type: "boolean", description: "Set to true/false to flag/unflag (optional)" },
        moveTo: { type: "string", description: "Destination folder URI (optional). Cannot be used with trash." },
        trash: { type: "boolean", description: "Set to true to move message to Trash (optional). Cannot be used with moveTo." },
      },
      required: ["folderPath"],
    },
  },
  {
    name: "createFolder",
    description: "Create a new mail subfolder under an existing folder",
    inputSchema: {
      type: "object",
      properties: {
        parentFolderPath: { type: "string", description: "URI of the parent folder (from listFolders)" },
        name: { type: "string", description: "Name for the new subfolder" },
      },
      required: ["parentFolderPath", "name"],
    },
  },
  {
    name: "listFilters",
    description: "List all mail filters/rules for an account with their conditions and actions",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from listAccounts (omit for all accounts)" },
      },
      required: [],
    },
  },
  {
    name: "createFilter",
    description: "Create a new mail filter rule on an account",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        name: { type: "string", description: "Filter name" },
        enabled: { type: "boolean", description: "Whether filter is active (default: true)" },
        type: { type: "number", description: "Filter type bitmask (default: 17 = inbox + manual). 1=inbox, 16=manual, 32=post-plugin, 64=post-outgoing" },
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              attrib: { type: "string", description: "Attribute: subject, from, to, cc, toOrCc, body, date, priority, status, size, ageInDays, hasAttachment, junkStatus, tag, otherHeader" },
              op: { type: "string", description: "Operator: contains, doesntContain, is, isnt, isEmpty, beginsWith, endsWith, isGreaterThan, isLessThan, isBefore, isAfter, matches, doesntMatch" },
              value: { type: "string", description: "Value to match against" },
              booleanAnd: { type: "boolean", description: "true=AND with previous, false=OR (default: true)" },
              header: { type: "string", description: "Custom header name (only when attrib is otherHeader)" },
            },
          },
          description: "Array of filter conditions",
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Action: moveToFolder, copyToFolder, markRead, markUnread, markFlagged, addTag, changePriority, delete, stopExecution, forward, reply" },
              value: { type: "string", description: "Action parameter (folder URI for move/copy, tag name for addTag, priority for changePriority, email for forward)" },
            },
          },
          description: "Array of actions to perform",
        },
        insertAtIndex: { type: "number", description: "Position to insert (0 = top priority, default: end of list)" },
      },
      required: ["accountId", "name", "conditions", "actions"],
    },
  },
  {
    name: "updateFilter",
    description: "Modify an existing filter's properties, conditions, or actions",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        filterIndex: { type: "number", description: "Filter index (from listFilters)" },
        name: { type: "string", description: "New filter name (optional)" },
        enabled: { type: "boolean", description: "Enable/disable (optional)" },
        type: { type: "number", description: "New filter type bitmask (optional)" },
        conditions: { type: "array", description: "Replace all conditions (optional, same format as createFilter)" },
        actions: { type: "array", description: "Replace all actions (optional, same format as createFilter)" },
      },
      required: ["accountId", "filterIndex"],
    },
  },
  {
    name: "deleteFilter",
    description: "Delete a mail filter by index",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        filterIndex: { type: "number", description: "Filter index to delete (from listFilters)" },
      },
      required: ["accountId", "filterIndex"],
    },
  },
  {
    name: "reorderFilters",
    description: "Move a filter to a different position in the execution order",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        fromIndex: { type: "number", description: "Current filter index" },
        toIndex: { type: "number", description: "Target index (0 = highest priority)" },
      },
      required: ["accountId", "fromIndex", "toIndex"],
    },
  },
  {
    name: "applyFilters",
    description: "Manually run all enabled filters on a folder to organize existing messages",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID (uses its filters)" },
        folderPath: { type: "string", description: "Folder URI to apply filters to (from listFolders)" },
      },
      required: ["accountId", "folderPath"],
    },
  },
];

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
  const message = JSON.parse(line);
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
          serverInfo: { name: 'thunderbird-mcp', version: '1.0.0' }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: TOOLS }
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
        'Content-Length': Buffer.byteLength(postData)
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
