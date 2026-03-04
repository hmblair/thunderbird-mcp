// utils.sys.mjs — Shared utilities for thunderbird-mcp modules

export function createUtils({ MailServices, Services, Cc, Ci, cal }) {

  function mcpWarn(context, error) {
    console.warn(`[thunderbird-mcp] ${context}:`, error?.message || error);
  }

  function parseDate(s) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(s);
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  function formatLocalJsDate(date) {
    if (!date) return null;
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatCalDateTime(dt) {
    if (!dt) return null;
    if (cal) {
      const local = dt.getInTimezone(cal.dtz.defaultTimezone);
      return `${local.year}-${pad2(local.month + 1)}-${pad2(local.day)}T${pad2(local.hour)}:${pad2(local.minute)}:${pad2(local.second)}`;
    }
    return formatLocalJsDate(new Date(dt.nativeTime / 1000));
  }

  function findIdentity(emailOrId) {
    if (!emailOrId) return null;
    const lowerInput = emailOrId.toLowerCase();
    for (const account of MailServices.accounts.accounts) {
      for (const identity of account.identities) {
        if (identity.key === emailOrId || (identity.email || "").toLowerCase() === lowerInput) {
          return identity;
        }
      }
    }
    return null;
  }

  function openFolder(folderPath) {
    try {
      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      if (folder.server && folder.server.type === "imap") {
        try {
          folder.updateFolder(null);
        } catch (e) { mcpWarn("IMAP folder refresh", e);
        }
      }

      const db = folder.msgDatabase;
      if (!db) {
        return { error: "Could not access folder database" };
      }

      return { folder, db };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function findFolderByFlag(root, flag) {
    if (!root) return null;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      try {
        if (current && typeof current.getFlag === "function" && current.getFlag(flag)) {
          return current;
        }
      } catch {}
      try {
        if (current?.hasSubFolders) {
          for (const sf of current.subFolders) stack.push(sf);
        }
      } catch {}
    }
    return null;
  }

  const TRASH_FLAG = 0x00000100;
  const JUNK_FLAG = 0x40000000;
  const DRAFTS_FLAG = 0x00000400;

  function findTrashFolder(folder) {
    let account = null;
    try {
      account = MailServices.accounts.findAccountForServer(folder.server);
    } catch (e) { mcpWarn("trash folder lookup", e);
      return null;
    }
    return findFolderByFlag(account?.incomingServer?.rootFolder, TRASH_FLAG);
  }

  function findJunkFolder(account) {
    return findFolderByFlag(account?.incomingServer?.rootFolder, JUNK_FLAG);
  }

  function findDraftsFolder(account) {
    return findFolderByFlag(account?.incomingServer?.rootFolder, DRAFTS_FLAG);
  }

  function resolveFolder(input) {
    if (!input || typeof input !== "string") return null;

    // Full URI — use directly
    if (input.includes("://")) {
      return MailServices.folderLookup.getFolderForURL(input);
    }

    // Short form: "accountId/Folder/Subfolder" or "accountId/Folder"
    const slashIdx = input.indexOf("/");
    if (slashIdx < 1) return null;

    const accountKey = input.substring(0, slashIdx);
    const pathParts = input.substring(slashIdx + 1).split("/").filter(Boolean);
    if (pathParts.length === 0) return null;

    let account = null;
    for (const a of MailServices.accounts.accounts) {
      if (a.key === accountKey) { account = a; break; }
    }
    if (!account) return null;

    const root = account.incomingServer?.rootFolder;
    if (!root) return null;

    // Walk folder tree matching each path segment by prettyName (case-insensitive)
    let current = root;
    for (const segment of pathParts) {
      const lower = segment.toLowerCase();
      let found = null;
      try {
        for (const sub of current.subFolders) {
          if ((sub.prettyName || "").toLowerCase() === lower ||
              (sub.name || "").toLowerCase() === lower) {
            found = sub;
            break;
          }
        }
      } catch {}
      if (!found) return null;
      current = found;
    }
    return current;
  }

  function getAccountId(folder) {
    try {
      return MailServices.accounts.findAccountForServer(folder.server)?.key || null;
    } catch { return null; }
  }

  function lookupMsgHdr(db, messageId) {
    let hdr = null;
    if (typeof db.getMsgHdrForMessageID === "function") {
      try { hdr = db.getMsgHdrForMessageID(messageId); } catch { hdr = null; }
    }
    if (!hdr) {
      for (const h of db.enumerateMessages()) {
        if (h.messageId === messageId) { hdr = h; break; }
      }
    }
    return hdr;
  }

  function findMessage(messageId, folderPath) {
    const opened = openFolder(folderPath);
    if (opened.error) return opened;

    const { folder, db } = opened;
    const msgHdr = lookupMsgHdr(db, messageId);

    if (!msgHdr) {
      return { error: `Message not found: ${messageId}` };
    }

    return { msgHdr, folder, db };
  }

  return {
    mcpWarn,
    parseDate,
    formatCalDateTime,
    formatLocalJsDate,
    findIdentity,
    findJunkFolder,
    openFolder,
    resolveFolder,
    findTrashFolder,
    findDraftsFolder,
    getAccountId,
    lookupMsgHdr,
    findMessage,
  };
}
