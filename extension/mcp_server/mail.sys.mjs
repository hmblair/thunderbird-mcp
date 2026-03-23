// mail.sys.mjs — Mail tools: accounts, folders, search, getThread, delete, update

export function createMailHandlers({ MailServices, Services, Cc, Ci, NetUtil, ChromeUtils, utils }) {
  const {
    mcpWarn, mcpDebug, openFolder, resolveFolder, findMessage, findTrashFolder, formatLocalJsDate, parseDate, resolveAccount, getPrimaryEmail, folderShortPath, shortId, resolveMsgHdrs,
  } = utils;

  const DEFAULT_MAX_RESULTS = 50;
  const MAX_SEARCH_RESULTS_CAP = 1000;
  const SEARCH_COLLECTION_CAP = 1000;

  // ── Gloda (cross-folder threading) ──────────────────────────────
  let Gloda = null;
  try {
    ({ Gloda } = ChromeUtils.importESModule(
      "resource:///modules/gloda/GlodaPublic.sys.mjs"
    ));
  } catch (e) {
    mcpWarn("Gloda import", e);
  }

  // Look up a msgHdr's Gloda conversation. Returns a Promise resolving to
  // { id, glodaMsg } or null if Gloda is unavailable / message not indexed.
  function glodaLookup(msgHdr) {
    if (!Gloda) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        Gloda.getMessageCollectionForHeader(msgHdr, {
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(coll) {
            const glodaMsg = coll.items[0];
            if (!glodaMsg || !glodaMsg.conversation) {
              resolve(null);
              return;
            }
            resolve({ id: String(glodaMsg.conversation.id), glodaMsg });
          }
        }, null);
      } catch (e) {
        mcpWarn("Gloda lookup", e);
        resolve(null);
      }
    });
  }

  // Return the Gloda conversation ID for a msgHdr, or null.
  function getThreadId(msgHdr) {
    return glodaLookup(msgHdr).then(r => r ? r.id : null);
  }


  function listAccounts(args) {
    const { includeLocal, accountTypes } = args || {};
    const typeFilter = Array.isArray(accountTypes) && accountTypes.length > 0 ? new Set(accountTypes) : null;
    const accounts = [];
    for (const account of MailServices.accounts.accounts) {
      const server = account.incomingServer;
      if (typeFilter && !typeFilter.has(server.type)) continue;
      if (!typeFilter && !includeLocal && server.type === "none") continue;
      const identities = [];
      for (const identity of account.identities) {
        identities.push({
          email: identity.email,
          name: identity.fullName
        });
      }
      accounts.push({
        name: server.prettyName,
        type: server.type,
        identities
      });
    }
    return accounts;
  }

  function listFolders(args) {
    const { accountId, folderPath, includeLocal, accountTypes } = args;
    const typeFilter = Array.isArray(accountTypes) && accountTypes.length > 0 ? new Set(accountTypes) : null;
    const results = [];

    function folderType(flags) {
      if (flags & 0x00001000) return "inbox";
      if (flags & 0x00000200) return "sent";
      if (flags & 0x00000400) return "drafts";
      if (flags & 0x00000100) return "trash";
      if (flags & 0x00400000) return "templates";
      if (flags & 0x00000800) return "queue";
      if (flags & 0x40000000) return "junk";
      if (flags & 0x00004000) return "archive";
      return "folder";
    }

    function walkFolder(folder, accountKey, depth) {
      try {
        if (folder.flags & 0x00000020) return;

        const prettyName = folder.prettyName;
        results.push({
          name: prettyName || folder.name || "(unnamed)",
          path: folderShortPath(folder),
          type: folderType(folder.flags),
          totalMessages: folder.getTotalMessages(false),
          unreadMessages: folder.getNumUnread(false),
          depth
        });
      } catch (e) { mcpWarn("folder access", e);
      }

      try {
        if (folder.hasSubFolders) {
          for (const subfolder of folder.subFolders) {
            walkFolder(subfolder, accountKey, depth + 1);
          }
        }
      } catch (e) { mcpWarn("subfolder traversal", e);
      }
    }

    if (folderPath) {
      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }
      const accountKey = folder.server
        ? (MailServices.accounts.findAccountForServer(folder.server)?.key || "unknown")
        : "unknown";
      walkFolder(folder, accountKey, 0);
      return results;
    }

    if (accountId) {
      const target = resolveAccount(accountId);
      if (!target) {
        return { error: `Account not found: ${accountId}` };
      }
      try {
        const root = target.incomingServer.rootFolder;
        if (root && root.hasSubFolders) {
          for (const subfolder of root.subFolders) {
            walkFolder(subfolder, target.key, 0);
          }
        }
      } catch (e) { mcpWarn("account folder access", e);
      }
      return results;
    }

    for (const account of MailServices.accounts.accounts) {
      try {
        const serverType = account.incomingServer.type;
        if (typeFilter && !typeFilter.has(serverType)) continue;
        if (!typeFilter && !includeLocal && serverType === "none") continue;
        const root = account.incomingServer.rootFolder;
        if (!root) continue;
        if (root.hasSubFolders) {
          for (const subfolder of root.subFolders) {
            walkFolder(subfolder, account.key, 0);
          }
        }
      } catch (e) { mcpWarn("account folder access", e);
      }
    }

    return results;
  }

  const INBOX_FLAG = 0x00001000;
  const SENT_FLAG = 0x00000200;
  const TRASH_FOLDER_FLAG = 0x00000100;
  const JUNK_FOLDER_FLAG = 0x40000000;
  const DRAFTS_FOLDER_FLAG = 0x00000400;

  async function searchMessages(args) {
    let { query, folderPath, accountId, startDate, endDate, maxResults, sortOrder, unreadOnly, flaggedOnly, snippetLength, countOnly, from, to, subject, hasAttachments, taggedWith, accountTypes, scope } = args;
    mcpDebug("searchMessages", { query, folderPath, accountId, from, to, subject, scope });
    if (typeof folderPath === "string") folderPath = [folderPath];
    const folderPaths = Array.isArray(folderPath) && folderPath.length > 0 ? folderPath : null;
    const typeFilter = Array.isArray(accountTypes) && accountTypes.length > 0 ? new Set(accountTypes) : null;
    const lowerQuery = (query || "").toLowerCase();
    const hasQuery = !!lowerQuery;
    const lowerFrom = from ? from.toLowerCase() : null;
    const lowerTo = to ? to.toLowerCase() : null;
    const lowerSubject = subject ? subject.toLowerCase() : null;
    const filterAttachments = hasAttachments === true || hasAttachments === "true";
    const filterTag = taggedWith || null;
    const parsedStartDate = startDate ? parseDate(startDate).getTime() : NaN;
    const parsedEndDate = endDate ? parseDate(endDate).getTime() : NaN;
    const startDateTs = Number.isFinite(parsedStartDate) ? parsedStartDate * 1000 : null;
    const endDateOffset = endDate && !endDate.includes("T") ? 86400000 : 0;
    const endDateTs = Number.isFinite(parsedEndDate) ? (parsedEndDate + endDateOffset) * 1000 : null;
    const requestedLimit = Number(maxResults);
    const effectiveLimit = Math.min(
      Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : DEFAULT_MAX_RESULTS,
      MAX_SEARCH_RESULTS_CAP
    );
    const normalizedSortOrder = sortOrder === "asc" ? "asc" : "desc";
    const snippetLen = Number.isFinite(Number(snippetLength)) && Number(snippetLength) > 0 ? Math.floor(Number(snippetLength)) : 0;

    const seenMsgs = new Set();
    let results = [];
    let count = 0;
    const effectiveScope = folderPaths ? null : (scope || "inbox");

    function isScopeMatch(folder) {
      if (!effectiveScope || effectiveScope === "all") return true;
      const flags = folder.flags || 0;
      if (effectiveScope === "inbox") {
        return !(flags & (TRASH_FOLDER_FLAG | JUNK_FOLDER_FLAG | SENT_FLAG | DRAFTS_FOLDER_FLAG));
      }
      if (effectiveScope === "sent") {
        return !!(flags & (SENT_FLAG | DRAFTS_FOLDER_FLAG));
      }
      if (effectiveScope === "trash") {
        return !!(flags & (TRASH_FOLDER_FLAG | JUNK_FOLDER_FLAG));
      }
      return true;
    }

    function searchFolder(folder) {
      if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) return;
      const matchesScope = isScopeMatch(folder);

      if (matchesScope) {
        try {
          if (folder.server && folder.server.type === "imap") {
            try {
              folder.updateFolder(null);
            } catch (e) { mcpWarn("IMAP folder refresh", e);
            }
          }

          const db = folder.msgDatabase;
          if (db) {
            for (const msgHdr of db.enumerateMessages()) {
              if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;

              const dedupKey = msgHdr.messageId;
              if (seenMsgs.has(dedupKey)) continue;
              seenMsgs.add(dedupKey);

              const msgDateTs = msgHdr.date || 0;
              if (startDateTs !== null && msgDateTs < startDateTs) continue;
              if (endDateTs !== null && msgDateTs > endDateTs) continue;
              if (unreadOnly && msgHdr.isRead) continue;
              if (flaggedOnly && !msgHdr.isFlagged) continue;

              if (hasQuery) {
                const subj = (msgHdr.mime2DecodedSubject || msgHdr.subject || "").toLowerCase();
                const author = (msgHdr.mime2DecodedAuthor || msgHdr.author || "").toLowerCase();
                const recip = (msgHdr.mime2DecodedRecipients || msgHdr.recipients || "").toLowerCase();
                const cc = (msgHdr.ccList || "").toLowerCase();
                if (!subj.includes(lowerQuery) &&
                    !author.includes(lowerQuery) &&
                    !recip.includes(lowerQuery) &&
                    !cc.includes(lowerQuery)) continue;
              }
              if (lowerFrom) {
                const author = (msgHdr.mime2DecodedAuthor || msgHdr.author || "").toLowerCase();
                if (!author.includes(lowerFrom)) continue;
              }
              if (lowerTo) {
                const recip = (msgHdr.mime2DecodedRecipients || msgHdr.recipients || "").toLowerCase();
                const cc = (msgHdr.ccList || "").toLowerCase();
                if (!recip.includes(lowerTo) && !cc.includes(lowerTo)) continue;
              }
              if (lowerSubject) {
                const subj = (msgHdr.mime2DecodedSubject || msgHdr.subject || "").toLowerCase();
                if (!subj.includes(lowerSubject)) continue;
              }
              if (filterAttachments) {
                const HAS_ATTACHMENT_FLAG = 0x10000000;
                if (!(msgHdr.flags & HAS_ATTACHMENT_FLAG)) continue;
              }
              if (filterTag) {
                const keywords = (msgHdr.getStringProperty("keywords") || "").toLowerCase();
                if (!keywords.includes(filterTag.toLowerCase())) continue;
              }

              if (countOnly) {
                count++;
                continue;
              }

              const entry = {
                id: shortId(msgHdr.messageId),
                subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
                author: msgHdr.mime2DecodedAuthor || msgHdr.author,
                recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
                ccList: msgHdr.ccList,
                date: msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : null,
                folder: folder.prettyName,
                folderPath: folderShortPath(folder),
                read: msgHdr.isRead,
                flagged: msgHdr.isFlagged,
                _dateTs: msgDateTs,
                _msgHdr: msgHdr,
              };
              if (snippetLen > 0) {
                try {
                  const preview = msgHdr.getStringProperty("preview") || "";
                  entry.snippet = preview.substring(0, snippetLen);
                } catch (e) { entry.snippet = ""; }
              }
              results.push(entry);
            }
          }
        } catch (e) { mcpWarn("message enumeration", e);
        }
      }

      if (folder.hasSubFolders) {
        for (const subfolder of folder.subFolders) {
          if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;
          searchFolder(subfolder);
        }
      }
    }

    if (folderPaths) {
      for (const fp of folderPaths) {
        const folder = resolveFolder(fp);
        if (!folder) {
          return { error: `Folder not found: ${fp}` };
        }
        searchFolder(folder);
        if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;
      }
    } else if (accountId) {
      const target = resolveAccount(accountId);
      if (!target) {
        return { error: `Account not found: ${accountId}` };
      }
      searchFolder(target.incomingServer.rootFolder);
    } else {
      for (const account of MailServices.accounts.accounts) {
        if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;
        if (typeFilter && !typeFilter.has(account.incomingServer.type)) continue;
        searchFolder(account.incomingServer.rootFolder);
      }
    }

    if (countOnly) {
      return { count };
    }

    // Sort and apply limit first (same as pre-grouping behaviour)
    results.sort((a, b) => normalizedSortOrder === "asc" ? a._dateTs - b._dateTs : b._dateTs - a._dateTs);
    results = results.slice(0, effectiveLimit);

    // Resolve Gloda conversation IDs in parallel for grouping
    await Promise.all(results.map(async (entry) => {
      try {
        entry._glodaConvId = await getThreadId(entry._msgHdr);
      } catch (e) {
        mcpWarn("threadId lookup", e);
      }
    }));

    // Group messages by Gloda conversation ID
    const threadMap = new Map();
    let ungroupedCounter = 0;
    for (const entry of results) {
      const key = entry._glodaConvId || `_ungrouped_${ungroupedCounter++}`;
      if (!threadMap.has(key)) threadMap.set(key, []);
      threadMap.get(key).push(entry);
    }

    // Build grouped output: each group is { messages: [...] }
    // Messages within each group sorted chronologically (ascending).
    // Groups sorted by most recent message (desc) or oldest (asc).
    const groups = [];
    for (const entries of threadMap.values()) {
      entries.sort((a, b) => a._dateTs - b._dateTs);
      const latestTs = entries[entries.length - 1]._dateTs;
      const oldestTs = entries[0]._dateTs;
      groups.push({
        _sortTs: normalizedSortOrder === "asc" ? oldestTs : latestTs,
        messages: entries.map(e => {
          delete e._dateTs;
          delete e._msgHdr;
          delete e._glodaConvId;
          return e;
        }),
      });
    }

    groups.sort((a, b) => normalizedSortOrder === "asc" ? a._sortTs - b._sortTs : b._sortTs - a._sortTs);

    return groups.map(g => ({ messages: g.messages }));
  }

  // ── Body extraction helpers ────────────────────────────────────
  function stripHtml(html) {
    if (!html) return "";
    let text = String(html);
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
    text = text.replace(/<(p|div|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n");
    text = text.replace(/<[^>]+>/g, " ");
    const NAMED_ENTITIES = {
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'",
    };
    text = text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gi, (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const cp = parseInt(entity.slice(2), 16);
        return cp ? String.fromCodePoint(cp) : match;
      }
      if (entity.startsWith("#")) {
        const cp = parseInt(entity.slice(1), 10);
        return cp ? String.fromCodePoint(cp) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] || match;
    });
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.replace(/[ \t\f\v]+/g, " ");
    text = text.replace(/ *\n */g, "\n");
    return text.trim();
  }

  function findBodyPart(part) {
    const contentType = ((part.contentType || "").split(";")[0] || "").trim().toLowerCase();
    if (contentType === "text/plain" && part.body) return { text: part.body, isHtml: false };
    if (contentType === "text/html" && part.body) return { text: part.body, isHtml: true };
    if (part.parts) {
      let htmlFallback = null;
      for (const sub of part.parts) {
        const result = findBodyPart(sub);
        if (result && !result.isHtml) return result;
        if (result && result.isHtml && !htmlFallback) htmlFallback = result;
      }
      if (htmlFallback) return htmlFallback;
    }
    return null;
  }

  function extractBody(aMimeMsg) {
    let body = "";
    try {
      body = aMimeMsg.coerceBodyToPlaintext();
    } catch (e) {
      mcpWarn("body extraction", e);
    }
    if (!body) {
      try {
        const found = findBodyPart(aMimeMsg);
        if (found) {
          body = found.isHtml ? stripHtml(found.text) : found.text;
        } else {
          body = "(Could not extract body text)";
        }
      } catch (e) {
        mcpWarn("body extraction fallback", e);
        body = "(Could not extract body text)";
      }
    }
    return body;
  }

  function extractAttachmentInfo(aMimeMsg) {
    const attachments = [];
    if (aMimeMsg && aMimeMsg.allUserAttachments) {
      for (const att of aMimeMsg.allUserAttachments) {
        attachments.push({
          name: att?.name || "",
          contentType: att?.contentType || "",
          size: typeof att?.size === "number" ? att.size : null,
        });
      }
    }
    return attachments;
  }

  // Parse a single msgHdr into a full message object with body.
  // Returns a Promise resolving to the message object.
  function readFullMessage(msgHdr) {
    const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
      "resource:///modules/gloda/MimeMessage.sys.mjs"
    );
    return new Promise((resolve) => {
      MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
        const msg = {
          id: shortId(msgHdr.messageId),
          subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
          author: msgHdr.mime2DecodedAuthor || msgHdr.author,
          recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
          ccList: msgHdr.ccList,
          date: msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : null,
          folderPath: folderShortPath(msgHdr.folder),
          read: msgHdr.isRead,
          body: aMimeMsg ? extractBody(aMimeMsg) : "(Could not parse message)",
          attachments: aMimeMsg ? extractAttachmentInfo(aMimeMsg) : [],
        };
        // Mark as read
        try { msgHdr.folder.markMessagesRead([msgHdr], true); } catch {}
        resolve(msg);
      }, true, { examineEncryptedParts: true });
    });
  }

  // ── getThread ─────────────────────────────────────────────────
  async function getThread(args) {
    const { messageId, folderPath } = args;
    mcpDebug("getThread", { messageId, folderPath });

    if (!messageId || !folderPath) {
      return { error: "messageId and folderPath are required" };
    }

    const found = findMessage(messageId, folderPath);
    if (found.error) return { error: found.error };
    const seedHdr = found.msgHdr;

    // Try Gloda for cross-folder thread resolution
    const glodaResult = await glodaLookup(seedHdr);

    if (glodaResult) {
      const convMsgs = await new Promise((resolve) => {
        glodaResult.glodaMsg.conversation.getMessagesCollection({
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(convColl) {
            const hdrs = [];
            for (const m of convColl.items) {
              const hdr = m.folderMessage;
              if (hdr) hdrs.push(hdr);
            }
            resolve(hdrs);
          }
        }, null);
      });

      convMsgs.sort((a, b) => (a.date || 0) - (b.date || 0));
      const messages = await Promise.all(convMsgs.map(hdr => readFullMessage(hdr)));
      return { messages };
    }

    // Fallback: Gloda unavailable or message not indexed — return single message
    const msg = await readFullMessage(seedHdr);
    return { messages: [msg] };
  }

  function deleteMessages(args) {
    let { messageIds, folderPath } = args;
    mcpDebug("deleteMessages", { messageIds, folderPath });
    try {
      if (typeof messageIds === "string") messageIds = [messageIds];
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { error: "messageIds is required" };
      }
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }

      const opened = openFolder(folderPath);
      if (opened.error) return { error: opened.error };
      const { folder, db } = opened;

      const { found, notFound } = resolveMsgHdrs(db, messageIds);

      if (found.length === 0) {
        return { error: "No matching messages found" };
      }

      folder.deleteMessages(found, null, false, true, null, false);

      const result = {
        message: `Requested deletion of ${found.length} ${found.length === 1 ? "message" : "messages"}`,
        requested: found.map(h => shortId(h.messageId)),
        folder: folderShortPath(folder),
      };
      if (notFound.length > 0) result.notFound = notFound;
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function deleteMessagesBySender(args) {
    let { from, accountId, scope } = args;
    mcpDebug("deleteMessagesBySender", { from, accountId, scope });
    try {
      if (!from) {
        return { error: "from is required (sender name or email substring)" };
      }
      if (typeof from === "string") from = [from];
      if (!Array.isArray(from) || from.length === 0) {
        return { error: "from must be a non-empty string or array of strings" };
      }

      const lowerFroms = from.map(f => f.toLowerCase());
      const effectiveScope = scope || "all";
      const targetAccountId = accountId || null;

      function isScopeMatch(folder) {
        if (effectiveScope === "all") return true;
        const flags = folder.flags || 0;
        if (effectiveScope === "inbox") {
          return !(flags & (TRASH_FOLDER_FLAG | JUNK_FOLDER_FLAG | SENT_FLAG | DRAFTS_FOLDER_FLAG));
        }
        if (effectiveScope === "sent") {
          return !!(flags & (SENT_FLAG | DRAFTS_FOLDER_FLAG));
        }
        if (effectiveScope === "trash") {
          return !!(flags & (TRASH_FOLDER_FLAG | JUNK_FOLDER_FLAG));
        }
        return true;
      }

      const folderBatches = new Map();
      let totalFound = 0;
      const seenMsgs = new Set();

      function collectFromFolder(folder) {
        if (!isScopeMatch(folder)) return;

        try {
          if (folder.server && folder.server.type === "imap") {
            try { folder.updateFolder(null); } catch (e) { mcpWarn("IMAP folder refresh", e); }
          }

          const db = folder.msgDatabase;
          if (!db) return;

          const matched = [];
          for (const msgHdr of db.enumerateMessages()) {
            const author = (msgHdr.mime2DecodedAuthor || msgHdr.author || "").toLowerCase();
            if (lowerFroms.some(lf => author.includes(lf))) {
              matched.push(msgHdr);
              const dedupKey = msgHdr.messageId;
              if (!seenMsgs.has(dedupKey)) {
                seenMsgs.add(dedupKey);
                totalFound++;
              }
            }
          }

          if (matched.length > 0) {
            folderBatches.set(folder, matched);
            totalFound += matched.length;
          }
        } catch (e) { mcpWarn("deleteMessagesBySender enumeration", e); }

        if (folder.hasSubFolders) {
          for (const subfolder of folder.subFolders) {
            collectFromFolder(subfolder);
          }
        }
      }

      if (targetAccountId) {
        const target = resolveAccount(targetAccountId);
        if (!target) {
          return { error: `Account not found: ${targetAccountId}` };
        }
        collectFromFolder(target.incomingServer.rootFolder);
      } else {
        for (const account of MailServices.accounts.accounts) {
          if (account.incomingServer.type === "none") continue;
          collectFromFolder(account.incomingServer.rootFolder);
        }
      }

      if (totalFound === 0) {
        return { message: "No messages found matching the specified sender(s)", deleted: 0 };
      }

      const deletedByFolder = [];
      for (const [folder, hdrs] of folderBatches) {
        folder.deleteMessages(hdrs, null, false, true, null, false);
        deletedByFolder.push({ folder: folderShortPath(folder), count: hdrs.length });
      }

      return {
        message: `Requested deletion of ${totalFound} ${totalFound === 1 ? "message" : "messages"} from ${from.join(", ")}`,
        deleted: totalFound,
        folders: deletedByFolder,
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function updateMessages(args) {
    let { messageIds, folderPath, read, flagged, moveTo, copyTo, trash, addTags, removeTags } = args;
    mcpDebug("updateMessages", { messageIds, folderPath, read, flagged, moveTo, copyTo, trash });
    try {
      if (typeof messageIds === "string") messageIds = [messageIds];
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { error: "messageIds is required" };
      }
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }

      if (read !== undefined) read = read === true || read === "true";
      if (flagged !== undefined) flagged = flagged === true || flagged === "true";
      if (trash !== undefined) trash = trash === true || trash === "true";
      if (moveTo !== undefined && (typeof moveTo !== "string" || !moveTo)) {
        return { error: "moveTo must be a non-empty string" };
      }
      if (copyTo !== undefined && (typeof copyTo !== "string" || !copyTo)) {
        return { error: "copyTo must be a non-empty string" };
      }

      const moveActions = [moveTo, copyTo, trash === true].filter(Boolean);
      if (moveActions.length > 1) {
        return { error: "Only one of moveTo, copyTo, or trash can be specified" };
      }

      const opened = openFolder(folderPath);
      if (opened.error) return { error: opened.error };
      const { folder, db } = opened;

      const { found: foundHdrs, notFound } = resolveMsgHdrs(db, messageIds);

      if (foundHdrs.length === 0) {
        return { error: "No matching messages found" };
      }

      const actions = [];

      if (read !== undefined) {
        folder.markMessagesRead(foundHdrs, read);
        actions.push({ type: "read", value: read });
      }

      if (flagged !== undefined) {
        folder.markMessagesFlagged(foundHdrs, flagged);
        actions.push({ type: "flagged", value: flagged });
      }

      if (addTags || removeTags) {
        for (const hdr of foundHdrs) {
          let keywords = (hdr.getStringProperty("keywords") || "").trim();
          let tagSet = new Set(keywords ? keywords.split(/\s+/) : []);
          if (addTags) {
            for (const t of addTags) tagSet.add(t);
          }
          if (removeTags) {
            for (const t of removeTags) tagSet.delete(t);
          }
          hdr.setStringProperty("keywords", [...tagSet].join(" "));
        }
        if (addTags) actions.push({ type: "addTags", value: addTags });
        if (removeTags) actions.push({ type: "removeTags", value: removeTags });
      }

      let targetFolder = null;
      let isCopy = false;

      if (trash === true) {
        targetFolder = findTrashFolder(folder);
        if (!targetFolder) {
          return { error: "Trash folder not found" };
        }
      } else if (moveTo) {
        targetFolder = resolveFolder(moveTo);
        if (!targetFolder) {
          return { error: `Folder not found: ${moveTo}` };
        }
      } else if (copyTo) {
        targetFolder = resolveFolder(copyTo);
        if (!targetFolder) {
          return { error: `Folder not found: ${copyTo}` };
        }
        isCopy = true;
      }

      if (targetFolder) {
        MailServices.copy.copyMessages(folder, foundHdrs, targetFolder, !isCopy, null, null, false);
        actions.push({ type: isCopy ? "copy" : "move", to: folderShortPath(targetFolder) });
      }

      const result = {
        message: `Requested update of ${foundHdrs.length} ${foundHdrs.length === 1 ? "message" : "messages"}`,
        updated: foundHdrs.length,
        actions,
      };
      if (notFound.length > 0) result.notFound = notFound;
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function getNewMail(args) {
    const { accountId } = args || {};
    mcpDebug("getNewMail", { accountId });
    try {
      if (accountId) {
        const account = resolveAccount(accountId);
        if (!account) {
          return { error: `Account not found: ${accountId}` };
        }
        const server = account.incomingServer;
        if (server.type === "none") {
          return { error: "Local Folders account does not support fetching mail" };
        }
        server.getNewMessages(server.rootFolder, null, null);
        return { message: "Fetch initiated", accountEmail: getPrimaryEmail(account) };
      }

      let count = 0;
      for (const account of MailServices.accounts.accounts) {
        const server = account.incomingServer;
        if (server.type === "none" || server.type === "rss") continue;
        try {
          server.getNewMessages(server.rootFolder, null, null);
          count++;
        } catch (e) { mcpWarn("getNewMail", e); }
      }

      if (count === 0) {
        return { error: "No mail accounts found" };
      }
      return { message: `Fetch initiated for ${count} ${count === 1 ? "account" : "accounts"}` };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function unsubscribe(args) {
    const { messageId, folderPath } = args;
    mcpDebug("unsubscribe", { messageId, folderPath });
    return new Promise((resolve) => {
      try {
        const found = findMessage(messageId, folderPath);
        if (found.error) { resolve({ error: found.error }); return; }
        const { msgHdr } = found;

        const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
          "resource:///modules/gloda/MimeMessage.sys.mjs"
        );

        MsgHdrToMimeMessage(msgHdr, null, async (aMsgHdr, aMimeMsg) => {
          if (!aMimeMsg) {
            resolve({ error: "Could not parse message" });
            return;
          }

          let url = null;
          try {
            const hdrVals = aMimeMsg.headers["list-unsubscribe"];
            if (hdrVals && hdrVals.length > 0) {
              const match = hdrVals[0].match(/<(https?:\/\/[^>]+)>/);
              if (match) url = match[1];
            }
          } catch (e) { /* no header */ }

          if (!url) {
            resolve({ error: "No List-Unsubscribe HTTP link found in message headers" });
            return;
          }

          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "List-Unsubscribe=One-Click"
            });
            resolve({
              url,
              status: response.status,
              success: response.ok,
              message: response.ok ? "Unsubscribe request sent" : `Server returned ${response.status}`
            });
          } catch (e) {
            resolve({ error: `HTTP request failed: ${e}`, url });
          }
        });
      } catch (e) {
        resolve({ error: e.toString() });
      }
    });
  }

  return {
    listAccounts,
    listFolders,
    searchMessages,
    getThread,
    deleteMessages,
    deleteMessagesBySender,
    updateMessages,
    getNewMail,
    unsubscribe,
  };
}
