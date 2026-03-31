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
| `getThread` | Read all messages in a conversation thread with full bodies — finds messages across folders via Gloda |
| `updateMessages` | Mark read/unread, flag/unflag, tag, move, copy, or trash (single or bulk) |
| `getNewMail` | Check for new mail from the server — one account or all at once |
| `deleteMessages` | Delete messages from a folder |
| `deleteMessagesBySender` | Delete all messages from one or more senders across all folders |
| `unsubscribe` | Unsubscribe from a mailing list via one-click POST (RFC 8058) |

### Compose

| Tool | Description |
|------|-------------|
| `createDraft` | Save a new message, reply, or forward as a draft — fully headless, no compose window |
| `sendDraft` | Send a draft message by its ID — use `searchMessages` on the Drafts folder to find drafts |

Drafts are saved directly to the Drafts folder. Supports new messages, replies (with threading and quoted text), and forwards (with original attachments). Add file attachments to any mode.

> **EWS/Exchange limitation:** `sendDraft` sends mail correctly via SMTP but cannot save a copy to the Sent folder on EWS accounts. This is a limitation of the underlying `nsIMsgSend` API with EWS. IMAP accounts are unaffected.

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

### Feeds

| Tool | Description |
|------|-------------|
| `listFeeds` | List subscribed RSS/Atom feeds |
| `subscribeFeed` | Subscribe to an RSS/Atom feed URL |
| `unsubscribeFeed` | Remove a feed subscription and its cached items |
| `refreshFeeds` | Trigger a feed refresh for a folder, account, or all RSS accounts |
| `createFeedAccount` | Create a new RSS/Atom feed account |

Feed items are stored as regular messages — use `searchMessages` and `getMessage` to read them.

### Account identifiers

**Email addresses are the only account identifier used in the public API.** All tools that accept an account identifier (including `searchMessages`, `listFolders`, `emptyTrash`, `emptyJunk`) accept:

- **Email address**: `hmblair@stanford.edu` (the only supported input format)

The internal Thunderbird account ID (e.g., `account5`) is **not exposed** in any responses. All responses that previously included `accountId` now only include `accountEmail`. When specifying an account, always use the email address.

### Folder paths

All tools that accept a `folderPath` (or `parentFolderPath`, `moveTo`, `copyTo`, `destinationParentPath`) use the format:

- **`email/FolderName/Subfolder`**: e.g. `hmblair@stanford.edu/Inbox`, `user@gmail.com/[Gmail]/All Mail`

Folder names are matched case-insensitively. Use `listAccounts` to find accounts and `listFolders` to see folder paths. All responses return paths in this same format, so you can pass them back directly as input.

### Mutation responses

Thunderbird's mail APIs are fire-and-forget — they do not return success or failure signals. All mutation tools reflect this honestly:

- Responses say `"Requested ..."` rather than claiming success
- Each response includes context: folder paths for mail operations, `calendarId`/`calendarName` for calendar/task operations
- To confirm an operation took effect, query the relevant data after the mutation (e.g. search for the message after moving it)

---

## Setup

Requires [Thunderbird](https://www.thunderbird.net/) 102 or later.

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

### Bridge options

The bridge accepts optional flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--tools=group1,group2` | all tools | Expose only specific tool groups (`mail`, `calendar`, `feeds`) |
| `--port=N` | `8765` | Thunderbird HTTP server port (must match extension config) |
| `--timeout=N` | `120000` | Request timeout in milliseconds |

### 3. Headless mode (optional)

Run Thunderbird on a virtual display (Xvfb) so MCP agents can access mail and calendar when no graphical session is active. Requires Xvfb running on display `:99`.

```bash
make install-headless
```

This installs a systemd user service, the `thunderbird-headless` command, and zsh completions. The service auto-restarts on failure and persists after logout via `loginctl enable-linger`.

```bash
thunderbird-headless start    # Start the service
thunderbird-headless stop     # Stop the service
thunderbird-headless status   # Show service status
```

To remove:

```bash
make uninstall-headless
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
| Missing recent emails | Use `getNewMail` to fetch from the server, or click the folder in Thunderbird to sync. For persistent issues, right-click > Properties > Repair Folder |
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
│       ├── feeds.sys.mjs       # RSS/Atom feed tools
│       ├── tools.json          # Tool definitions and schemas
│       └── schema.json
├── headless/
│   ├── thunderbird-headless        # Start/stop/status command
│   ├── thunderbird-mcp.service     # Systemd user service (Xvfb :99)
│   └── _thunderbird-headless       # Zsh completions
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
