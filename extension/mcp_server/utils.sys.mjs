// utils.sys.mjs — Shared utilities for thunderbird-mcp modules

export function createUtils({ MailServices, Services, Cc, Ci, cal }) {

  function mcpWarn(context, error) {
    console.warn(`[thunderbird-mcp] ${context}:`, error?.message || error);
  }

  function mcpDebug(context, data) {
    console.log(`[thunderbird-mcp:debug] ${context}:`, JSON.stringify(data));
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
          mcpDebug("findIdentity", { input: emailOrId, matched: identity.email, key: identity.key, account: account.key });
          return identity;
        }
      }
    }
    mcpDebug("findIdentity", { input: emailOrId, matched: null });
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
  const SENT_FLAG = 0x00000200;

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

  function findSentFolder(account) {
    return findFolderByFlag(account?.incomingServer?.rootFolder, SENT_FLAG);
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

    const account = resolveAccount(accountKey);
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

  function resolveAccount(accountId) {
    if (!accountId || typeof accountId !== "string") return null;
    const lower = accountId.toLowerCase();
    for (const account of MailServices.accounts.accounts) {
      if (account.key === accountId) return account;
      if ((account.incomingServer?.prettyName || "").toLowerCase() === lower) return account;
      for (const identity of account.identities) {
        if ((identity.email || "").toLowerCase() === lower) return account;
      }
    }
    return null;
  }

  function resolveAccountEmail(accountId) {
    if (!accountId || typeof accountId !== "string") return null;
    const lower = accountId.toLowerCase();
    for (const account of MailServices.accounts.accounts) {
      // Direct email match
      for (const identity of account.identities) {
        if ((identity.email || "").toLowerCase() === lower) {
          return identity.email;
        }
      }
      // Account ID match - return primary identity email
      if (account.key === accountId) {
        return account.defaultIdentity?.email || null;
      }
      // Display name match - return primary identity email
      if ((account.incomingServer?.prettyName || "").toLowerCase() === lower) {
        return account.defaultIdentity?.email || null;
      }
    }
    return null;
  }

  function getPrimaryEmail(account) {
    if (!account) return null;
    return account.defaultIdentity?.email || null;
  }

  function folderShortPath(folder) {
    if (!folder) return null;
    const segments = [];
    let current = folder;
    while (current && current.parent) {
      segments.unshift(current.prettyName || current.name);
      current = current.parent;
    }
    let prefix = "Local Folders";
    try {
      const account = MailServices.accounts.findAccountForServer(folder.server);
      if (account) {
        prefix = getPrimaryEmail(account) || account.incomingServer?.prettyName || "Local Folders";
      }
    } catch {}
    return prefix + "/" + segments.join("/");
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

  function resolveMsgHdrs(db, messageIds) {
    const found = [];
    const notFound = [];
    for (const msgId of messageIds) {
      if (typeof msgId !== "string" || !msgId) { notFound.push(msgId); continue; }
      const hdr = lookupMsgHdr(db, msgId);
      if (hdr) { found.push(hdr); } else { notFound.push(msgId); }
    }
    return { found, notFound };
  }

  function findWritableCalendar(calendarId) {
    if (!cal) return { error: "Calendar not available" };
    const calendars = cal.manager.getCalendars();
    if (calendarId) {
      const target = calendars.find(c => c.id === calendarId);
      if (!target) return { error: `Calendar not found: ${calendarId}` };
      if (target.readOnly) return { error: `Calendar is read-only: ${target.name}` };
      return { calendar: target };
    }
    const target = calendars.find(c => !c.readOnly);
    if (!target) return { error: "No writable calendar found" };
    return { calendar: target };
  }

  function resolveAccounts(accountId) {
    const accounts = accountId
      ? [resolveAccount(accountId)].filter(Boolean)
      : [...MailServices.accounts.accounts];
    if (accounts.length === 0) {
      return { error: accountId ? `Account not found: ${accountId}` : "No accounts found" };
    }
    return { accounts };
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
    mcpDebug,
    parseDate,
    formatCalDateTime,
    formatLocalJsDate,
    findIdentity,
    findJunkFolder,
    openFolder,
    resolveFolder,
    findTrashFolder,
    findDraftsFolder,
    findSentFolder,
    getAccountId,
    resolveAccount,
    resolveAccountEmail,
    getPrimaryEmail,
    folderShortPath,
    lookupMsgHdr,
    resolveMsgHdrs,
    findWritableCalendar,
    resolveAccounts,
    findMessage,
  };
}
