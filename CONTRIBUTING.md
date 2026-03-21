# Contributing

## Adding a new tool

Adding a tool requires changes in three places:

### 1. Handler function

Write the handler in the appropriate domain module under `extension/mcp_server/`:

| Module | Domain |
|--------|--------|
| `mail.sys.mjs` | Accounts, folders, search, messages, unsubscribe |
| `compose.sys.mjs` | Draft creation and sending |
| `folders.sys.mjs` | Folder management (create, rename, delete, move) |
| `calendar.sys.mjs` | Calendar events |
| `tasks.sys.mjs` | Tasks/todos |
| `contacts.sys.mjs` | Contact lookup |
| `feeds.sys.mjs` | RSS/Atom feed management |

The handler function must be exported in the module's return object. The function name becomes the handler name used for routing.

### 2. Tool definition

Add a JSON entry to `extension/mcp_server/tools.json` with `name`, `title`, `description`, and `inputSchema`. The `name` must match the handler function name (unless remapped in `toolNameMap` in `api.js`).

### 3. Bridge tool group

Add the tool name to the appropriate group in `TOOL_GROUPS` at the top of `mcp-bridge.cjs`. Available groups: `mail`, `calendar`, `feeds`. If the tool isn't in a group, it won't be exposed when the bridge runs with `--tools=<group>`.

### After making changes

1. Rebuild the XPI: `make`
2. Reinstall in Thunderbird: Tools > Add-ons > Install from File
3. Restart Thunderbird (required for extension code changes)
4. Restart the bridge process (required for `mcp-bridge.cjs` or `tools.json` changes)
5. Reconnect your MCP client (`/mcp` in Claude Code)

## Architecture

```
MCP Client  <--stdio-->  mcp-bridge.cjs  <--HTTP-->  Thunderbird Extension
                         (Node.js)                    (api.js + domain modules)
```

- `mcp-bridge.cjs` serves `tools/list` locally from `tools.json` and forwards `tools/call` to the extension's HTTP server on `localhost:8765`.
- `api.js` routes incoming calls to handler functions by matching the tool name against the handlers object (merged from all domain modules).
- Domain modules receive shared dependencies (`MailServices`, `Services`, `ChromeUtils`, `utils`, etc.) via dependency injection from `api.js`.

## Thunderbird API notes

- `msgHdr.getStringProperty(name)` only works for properties Thunderbird indexes (e.g. `keywords`, `preview`, `inReplyTo`, `references`). Arbitrary MIME headers require streaming the message via `MsgHdrToMimeMessage` and reading `aMimeMsg.headers[name]`.
- Mail mutation APIs (move, copy, delete, mark read) are fire-and-forget. They don't return success/failure.
- IMAP folder databases can be stale. Call `folder.updateFolder(null)` before enumerating messages.
- `fetch()` is available in the privileged extension context for outbound HTTP requests.
