# Thunderbird MCP

[![24 Tools](https://img.shields.io/badge/24_Tools-mail%2C_calendar%2C_tasks%2C_contacts-blue.svg)](#tools)
[![Localhost Only](https://img.shields.io/badge/Privacy-localhost_only-green.svg)](#security)
[![Thunderbird](https://img.shields.io/badge/Thunderbird-102%2B-0a84ff.svg)](https://www.thunderbird.net/)
[![License: MIT](https://img.shields.io/badge/License-MIT-grey.svg)](LICENSE)

Give your AI assistant full access to Thunderbird — read and organize mail, manage calendars and tasks, compose messages, and look up contacts. All through the [Model Context Protocol](https://modelcontextprotocol.io/).

> Inspired by [bb1/thunderbird-mcp](https://github.com/bb1/thunderbird-mcp). Rewritten from scratch with a bundled HTTP server, proper MIME decoding, and UTF-8 handling throughout.

---

## How it works

```
                    stdio              HTTP (localhost:8765)
  MCP Client  <----------->  Bridge  <--------------------->  Thunderbird
  (Claude, etc.)           mcp-bridge.cjs                    Extension + HTTP Server
```

The Thunderbird extension embeds a local HTTP server. The Node.js bridge translates between MCP's stdio protocol and HTTP. Your AI talks stdio, Thunderbird talks HTTP, the bridge connects them.

---

## Tools

### Mail

| Tool | Description |
|------|-------------|
| `listAccounts` | List all email accounts and their identities |
| `listFolders` | Browse folder tree with message counts — filter by account or subtree |
| `searchMessages` | Search and list messages by query, date range, folder, read/flagged status, or just count them |
| `getMessage` | Read full email content with optional attachment saving to disk |
| `updateMessage` | Mark read/unread, flag/unflag, tag, move, copy, or trash (single or bulk) |
| `deleteMessages` | Delete messages from a folder |

### Compose

| Tool | Description |
|------|-------------|
| `createDraft` | Save a new message, reply, or forward as a draft — fully headless, no compose window |

Drafts are saved directly to the Drafts folder. Supports new messages, replies (with threading and quoted text), and forwards (with original attachments). Add file attachments to any mode.

### Folders

| Tool | Description |
|------|-------------|
| `createFolder` | Create new subfolders to organize your mail |
| `renameFolder` | Rename an existing mail folder |
| `deleteFolder` | Delete a folder (moves to Trash by default) |
| `moveFolder` | Move a folder under a different parent |
| `emptyTrash` | Permanently delete all messages in Trash |
| `emptyJunk` | Permanently delete all messages in Junk/Spam |

### Calendar

| Tool | Description |
|------|-------------|
| `listCalendars` | List all calendars (local and CalDAV) |
| `listEvents` | List events within a date range |
| `createEvent` | Create a calendar event |
| `updateEvent` | Update an event's title, dates, location, or description |
| `deleteEvent` | Delete a calendar event |

### Tasks

| Tool | Description |
|------|-------------|
| `listTasks` | List todos from calendars, filtered by date range and completion status |
| `createTask` | Create a todo |
| `updateTask` | Update a task's title, due date, priority, status, or completion percentage |
| `deleteTask` | Delete a task |

### Contacts

| Tool | Description |
|------|-------------|
| `searchContacts` | Look up contacts by name or email address |

---

## Setup

### 1. Install the extension

```bash
git clone https://github.com/TKasperczyk/thunderbird-mcp.git
```

Build and install the extension:

```bash
make
```

Then install `dist/thunderbird-mcp.xpi` in Thunderbird (Tools > Add-ons > Install from File) and restart.

### 2. Configure your MCP client

Add to your MCP client config (e.g. `~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "thunderbird-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/thunderbird-mcp/mcp-bridge.cjs"]
    }
  }
}
```

That's it. Your AI can now access Thunderbird.

---

## Security

The extension listens on `localhost:8765` only. No remote access. However, any local process can reach it while Thunderbird is running — keep this in mind on shared machines.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension not loading | Check Tools > Add-ons and Themes. Errors: Tools > Developer Tools > Error Console |
| Connection refused | Make sure Thunderbird is running and the extension is enabled |
| Missing recent emails | IMAP folders can be stale. Click the folder in Thunderbird to sync, or right-click > Properties > Repair Folder |
| Tool not found after update | Reconnect MCP (`/mcp` in Claude Code) to pick up new tools |

---

## Development

```bash
# Build the extension
make

# Install: open dist/thunderbird-mcp.xpi in Thunderbird
# (Tools > Add-ons > Install from File), then restart

# Test the HTTP API directly
curl -X POST http://localhost:8765 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Test the bridge
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp-bridge.cjs
```

After changing extension code: rebuild the XPI, reinstall in Thunderbird, and restart.

---

## Project structure

```
thunderbird-mcp/
├── mcp-bridge.cjs              # stdio <-> HTTP bridge
├── extension/
│   ├── manifest.json
│   ├── background.js           # Extension entry point
│   ├── httpd.sys.mjs           # Embedded HTTP server (Mozilla)
│   └── mcp_server/
│       ├── api.js              # Entry point: server setup, MCP routing
│       ├── utils.sys.mjs       # Shared utilities
│       ├── mail.sys.mjs        # Mail tools (accounts, folders, search, messages)
│       ├── compose.sys.mjs     # Compose tools (createDraft)
│       ├── folders.sys.mjs     # Folder management tools
│       ├── calendar.sys.mjs    # Calendar tools (events)
│       ├── tasks.sys.mjs       # Task/todo tools
│       ├── contacts.sys.mjs    # Contact tools
│       ├── tools.json          # Tool definitions and schemas
│       └── schema.json
└── Makefile
```

## Known issues

- IMAP folder databases can be stale until you click on them in Thunderbird
- Email bodies with control characters are sanitized to avoid breaking JSON
- HTML-only emails are converted to plain text (original formatting is lost)
- **EWS (Exchange) drafts**: Drafts created via `createDraft` on EWS accounts may not delete properly through `deleteMessages` or the Thunderbird UI. **Do not use "Repair Folder" on the EWS Drafts folder** — it can permanently remove the folder from the local cache, requiring an account re-add to restore it. This is a Thunderbird EWS backend limitation.

---

## License

MIT. The bundled `httpd.sys.mjs` is from Mozilla and licensed under MPL-2.0.
