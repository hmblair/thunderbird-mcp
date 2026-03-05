# Thunderbird MCP

Give your AI assistant full access to Thunderbird — read and organize mail, manage calendars and tasks, compose messages, and look up contacts. All through the [Model Context Protocol](https://modelcontextprotocol.io/).

Fork of [TKasperczyk/thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp), which was itself inspired by [bb1/thunderbird-mcp](https://github.com/bb1/thunderbird-mcp).

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
| `searchMessages` | Search messages by query, sender, recipient, subject, date range, folder, account, tags, attachments, read/flagged status, or just count them |
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
| `createEvent` | Create a calendar event (supports recurring events via RRULE) |
| `updateEvent` | Update an event's title, dates, location, description, or recurrence |
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

### Account identifiers

All tools that accept `accountId` (including `searchMessages`, `listFolders`, `emptyTrash`, `emptyJunk`) accept any of:

- **Internal ID**: `account5`
- **Email address**: `hmblair@stanford.edu`
- **Display name**: `hmblair@stanford.edu` (the server's pretty name)

### Folder paths

All tools that accept a `folderPath` (or `parentFolderPath`, `moveTo`, `copyTo`, `destinationParentPath`) support two formats:

- **Full URI**: `ews://hmblair%40stanford.edu@outlook.office365.com/Inbox`
- **Short path**: `account5/Inbox`, `hmblair@stanford.edu/Sent Items`

Short paths use the format `account/FolderName/Subfolder`, where `account` can be an ID, email, or display name. Folder names are matched case-insensitively. Use `listAccounts` to find accounts and `listFolders` to see folder names.

### Mutation responses

Thunderbird's mail APIs are fire-and-forget — they do not return success or failure signals. All mutation tools reflect this honestly:

- Responses say `"Requested ..."` rather than claiming success
- Each response includes context: `accountId` for mail operations, `calendarId`/`calendarName` for calendar/task operations
- To confirm an operation took effect, query the relevant data after the mutation (e.g. search for the message after moving it)

---

## Setup

Requires [Thunderbird](https://www.thunderbird.net/) 115 or later.

### 1. Install the extension

```bash
git clone https://github.com/hmblair/thunderbird-mcp.git
```

Build and install the extension:

```bash
make
```

Then install `dist/thunderbird-mcp.xpi` in Thunderbird (Tools > Add-ons > Install from File) and restart.

### 2. Configure your MCP client

```bash
make install
```

This walks you through adding thunderbird-mcp to your MCP client configs (Claude Code and/or OpenCode). Tools are split into separate servers (`thunderbird-mail`, `thunderbird-calendar`, `thunderbird-feeds`) so you can enable them independently.

To remove the config entries later:

```bash
make uninstall
```

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
