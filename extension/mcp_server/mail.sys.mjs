// mail.sys.mjs — Mail tools: accounts, folders, search, getMessage, recent, delete, update

export function createMailHandlers({ MailServices, Services, Cc, Ci, NetUtil, ChromeUtils, utils }) {
  const {
    mcpWarn, openFolder, resolveFolder, findMessage, findTrashFolder, formatLocalJsDate, parseDate, getAccountId, resolveAccount, lookupMsgHdr,
  } = utils;

  const DEFAULT_MAX_RESULTS = 50;
  const MAX_SEARCH_RESULTS_CAP = 1000;
  const SEARCH_COLLECTION_CAP = 1000;

  function listAccounts(args) {
    const { includeLocal } = args || {};
    const accounts = [];
    for (const account of MailServices.accounts.accounts) {
      const server = account.incomingServer;
      if (!includeLocal && server.type === "none") continue;
      const identities = [];
      for (const identity of account.identities) {
        identities.push({
          id: identity.key,
          email: identity.email,
          name: identity.fullName,
          isDefault: identity === account.defaultIdentity
        });
      }
      accounts.push({
        id: account.key,
        name: server.prettyName,
        type: server.type,
        identities
      });
    }
    return accounts;
  }

  function listFolders(args) {
    const { accountId, folderPath, includeLocal } = args;
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
          path: folder.URI,
          type: folderType(folder.flags),
          accountId: accountKey,
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
        if (!includeLocal && account.incomingServer.type === "none") continue;
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

  function searchMessages(args) {
    const { query, folderPath, accountId, startDate, endDate, maxResults, sortOrder, unreadOnly, flaggedOnly, snippetLength, countOnly, from, to, subject, hasAttachments, taggedWith } = args;
    const results = [];
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
    let count = 0;

    function searchFolder(folder) {
      if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) return;

      try {
        if (folder.server && folder.server.type === "imap") {
          try {
            folder.updateFolder(null);
          } catch (e) { mcpWarn("IMAP folder refresh", e);
          }
        }

        const db = folder.msgDatabase;
        if (!db) return;

        for (const msgHdr of db.enumerateMessages()) {
          if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;

          const dedupKey = `${folder.URI}\t${msgHdr.messageId}`;
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

          let threadId = null;
          try {
            const thread = db.getThreadContainingMsgHdr(msgHdr);
            if (thread && thread.threadKey < 0xFFFFFFFE) threadId = thread.threadKey;
          } catch {}
          const entry = {
            id: msgHdr.messageId,
            threadId,
            subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
            author: msgHdr.mime2DecodedAuthor || msgHdr.author,
            recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
            ccList: msgHdr.ccList,
            date: msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : null,
            folder: folder.prettyName,
            folderPath: folder.URI,
            accountId: getAccountId(folder),
            read: msgHdr.isRead,
            flagged: msgHdr.isFlagged,
            _dateTs: msgDateTs
          };
          if (snippetLen > 0) {
            try {
              const preview = msgHdr.getStringProperty("preview") || "";
              entry.snippet = preview.substring(0, snippetLen);
            } catch (e) { entry.snippet = ""; }
          }
          results.push(entry);
        }
      } catch (e) { mcpWarn("message enumeration", e);
      }

      if (folder.hasSubFolders) {
        for (const subfolder of folder.subFolders) {
          if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;
          searchFolder(subfolder);
        }
      }
    }

    if (folderPath) {
      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }
      searchFolder(folder);
    } else if (accountId) {
      const target = resolveAccount(accountId);
      if (!target) {
        return { error: `Account not found: ${accountId}` };
      }
      searchFolder(target.incomingServer.rootFolder);
    } else {
      for (const account of MailServices.accounts.accounts) {
        if (!countOnly && results.length >= SEARCH_COLLECTION_CAP) break;
        searchFolder(account.incomingServer.rootFolder);
      }
    }

    if (countOnly) {
      return { count };
    }

    results.sort((a, b) => normalizedSortOrder === "asc" ? a._dateTs - b._dateTs : b._dateTs - a._dateTs);

    return results.slice(0, effectiveLimit).map(result => {
      delete result._dateTs;
      return result;
    });
  }

  function getMessage(args) {
    const { messageId, folderPath, saveAttachments } = args;
    return new Promise((resolve) => {
      try {
        const found = findMessage(messageId, folderPath);
        if (found.error) {
          resolve({ error: found.error });
          return;
        }
        const { msgHdr } = found;

        const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
          "resource:///modules/gloda/MimeMessage.sys.mjs"
        );

        MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
          if (!aMimeMsg) {
            resolve({ error: "Could not parse message" });
            return;
          }

          let body = "";
          let bodyIsHtml = false;
          try {
            body = aMimeMsg.coerceBodyToPlaintext();
          } catch (e) { mcpWarn("body extraction", e);
            body = "";
          }

          if (!body) {
            try {
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
                  nbsp: " ",
                  amp: "&",
                  lt: "<",
                  gt: ">",
                  quot: "\"",
                  apos: "'",
                  "#39": "'",
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
                text = text.trim();
                return text;
              }

              function findBody(part) {
                const contentType = ((part.contentType || "").split(";")[0] || "").trim().toLowerCase();
                if (contentType === "text/plain" && part.body) {
                  return { text: part.body, isHtml: false };
                }
                if (contentType === "text/html" && part.body) {
                  return { text: part.body, isHtml: true };
                }
                if (part.parts) {
                  let htmlFallback = null;
                  for (const sub of part.parts) {
                    const result = findBody(sub);
                    if (result && !result.isHtml) return result;
                    if (result && result.isHtml && !htmlFallback) htmlFallback = result;
                  }
                  if (htmlFallback) return htmlFallback;
                }
                return null;
              }
              const found = findBody(aMimeMsg);
              if (found) {
                let extracted = found.text;
                if (found.isHtml) {
                  extracted = stripHtml(extracted);
                  bodyIsHtml = false;
                } else {
                  bodyIsHtml = false;
                }
                body = extracted;
              } else {
                body = "(Could not extract body text)";
              }
            } catch (e) { mcpWarn("body extraction fallback", e);
              body = "(Could not extract body text)";
            }
          }

          const attachments = [];
          const attachmentSources = [];
          if (aMimeMsg && aMimeMsg.allUserAttachments) {
            for (const att of aMimeMsg.allUserAttachments) {
              const info = {
                name: att?.name || "",
                contentType: att?.contentType || "",
                size: typeof att?.size === "number" ? att.size : null
              };
              attachments.push(info);
              attachmentSources.push({
                info,
                url: att?.url || "",
                size: typeof att?.size === "number" ? att.size : null
              });
            }
          }

          const baseResponse = {
            id: msgHdr.messageId,
            subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
            author: msgHdr.mime2DecodedAuthor || msgHdr.author,
            recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
            ccList: msgHdr.ccList,
            date: msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : null,
            accountId: getAccountId(found.folder),
            body,
            bodyIsHtml,
            attachments
          };

          if (!saveAttachments || attachmentSources.length === 0) {
            resolve(baseResponse);
            return;
          }

          function sanitizePathSegment(s) {
            const sanitized = String(s || "").replace(/[^a-zA-Z0-9]/g, "_");
            return sanitized || "message";
          }

          function sanitizeFilename(s) {
            let name = String(s || "").trim();
            if (!name) name = "attachment";
            name = name.replace(/[^a-zA-Z0-9._-]/g, "_");
            name = name.replace(/^_+/, "").replace(/_+$/, "");
            return name || "attachment";
          }

          function ensureAttachmentDir(sanitizedId) {
            const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
            const root = tmpDir.clone();
            root.append("thunderbird-mcp");
            try {
              root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
            } catch (e) {
              if (!root.exists() || !root.isDirectory()) throw e;
            }
            const dir = root.clone();
            dir.append(sanitizedId);
            try {
              dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
            } catch (e) {
              if (!dir.exists() || !dir.isDirectory()) throw e;
            }
            return dir;
          }

          const sanitizedId = sanitizePathSegment(messageId);
          let dir;
          try {
            dir = ensureAttachmentDir(sanitizedId);
          } catch (e) {
            for (const { info } of attachmentSources) {
              info.error = `Failed to create attachment directory: ${e}`;
            }
            resolve(baseResponse);
            return;
          }

          const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

          const saveOne = ({ info, url, size }, index) =>
            new Promise((done) => {
              try {
                if (!url) {
                  info.error = "Missing attachment URL";
                  done();
                  return;
                }

                const knownSize = typeof size === "number" ? size : null;
                if (knownSize !== null && knownSize > MAX_ATTACHMENT_BYTES) {
                  info.error = `Attachment too large (${knownSize} bytes, limit ${MAX_ATTACHMENT_BYTES})`;
                  done();
                  return;
                }

                const idx = typeof index === "number" && Number.isFinite(index) ? index : 0;
                let safeName = sanitizeFilename(info.name);
                if (!safeName || safeName === "." || safeName === "..") {
                  safeName = `attachment_${idx}`;
                }
                const file = dir.clone();
                file.append(safeName);

                try {
                  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);
                } catch (e) {
                  info.error = `Failed to create file: ${e}`;
                  done();
                  return;
                }

                const channel = NetUtil.newChannel({
                  uri: url,
                  loadUsingSystemPrincipal: true
                });

                NetUtil.asyncFetch(channel, (inputStream, status, request) => {
                  try {
                    if (status && status !== 0) {
                      try { inputStream?.close(); } catch {}
                      info.error = `Fetch failed: ${status}`;
                      try { file.remove(false); } catch {}
                      done();
                      return;
                    }
                    if (!inputStream) {
                      info.error = "Fetch returned no data";
                      try { file.remove(false); } catch {}
                      done();
                      return;
                    }

                    try {
                      const reqLen = request && typeof request.contentLength === "number" ? request.contentLength : -1;
                      if (reqLen >= 0 && reqLen > MAX_ATTACHMENT_BYTES) {
                        try { inputStream.close(); } catch {}
                        info.error = `Attachment too large (${reqLen} bytes, limit ${MAX_ATTACHMENT_BYTES})`;
                        try { file.remove(false); } catch {}
                        done();
                        return;
                      }
                    } catch {
                      // ignore contentLength failures
                    }

                    const ostream = Cc["@mozilla.org/network/file-output-stream;1"]
                      .createInstance(Ci.nsIFileOutputStream);
                    ostream.init(file, -1, -1, 0);

                    NetUtil.asyncCopy(inputStream, ostream, (copyStatus) => {
                      try {
                        if (copyStatus && copyStatus !== 0) {
                          info.error = `Write failed: ${copyStatus}`;
                          try { file.remove(false); } catch {}
                          done();
                          return;
                        }

                        try {
                          if (file.fileSize > MAX_ATTACHMENT_BYTES) {
                            info.error = `Attachment too large (${file.fileSize} bytes, limit ${MAX_ATTACHMENT_BYTES})`;
                            try { file.remove(false); } catch {}
                            done();
                            return;
                          }
                        } catch {
                          // ignore fileSize failures
                        }

                        info.filePath = file.path;
                        done();
                      } catch (e) {
                        info.error = `Write failed: ${e}`;
                        try { file.remove(false); } catch {}
                        done();
                      }
                    });
                  } catch (e) {
                    info.error = `Fetch failed: ${e}`;
                    try { file.remove(false); } catch {}
                    done();
                  }
                });
              } catch (e) {
                info.error = String(e);
                done();
              }
            });

          (async () => {
            try {
              await Promise.all(attachmentSources.map((src, i) => saveOne(src, i)));
            } catch (e) {
              for (const { info } of attachmentSources) {
                if (!info.error) info.error = `Unexpected save error: ${e}`;
              }
            }
            resolve(baseResponse);
          })();
        }, true, { examineEncryptedParts: true });

      } catch (e) {
        resolve({ error: e.toString() });
      }
    });
  }

  function deleteMessages(args) {
    let { messageIds, folderPath } = args;
    try {
      if (typeof messageIds === "string") {
        try { messageIds = JSON.parse(messageIds); } catch { /* leave as-is */ }
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { error: "messageIds must be a non-empty array of strings" };
      }
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }

      const opened = openFolder(folderPath);
      if (opened.error) return { error: opened.error };
      const { folder, db } = opened;

      const found = [];
      const notFound = [];
      for (const msgId of messageIds) {
        if (typeof msgId !== "string" || !msgId) { notFound.push(msgId); continue; }
        const hdr = lookupMsgHdr(db, msgId);
        if (hdr) { found.push(hdr); } else { notFound.push(msgId); }
      }

      if (found.length === 0) {
        return { error: "No matching messages found" };
      }

      folder.deleteMessages(found, null, false, true, null, false);

      const result = {
        message: `Requested deletion of ${found.length} message(s)`,
        requested: found.map(h => h.messageId),
        accountId: getAccountId(folder),
        folder: folder.URI,
      };
      if (notFound.length > 0) result.notFound = notFound;
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function updateMessage(args) {
    let { messageId, messageIds, folderPath, read, flagged, moveTo, copyTo, trash, addTags, removeTags } = args;
    try {
      if (typeof messageIds === "string") {
        try { messageIds = JSON.parse(messageIds); } catch { /* leave as-is */ }
      }
      if (messageId && messageIds) {
        return { error: "Specify messageId or messageIds, not both" };
      }
      if (messageId) {
        messageIds = [messageId];
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { error: "messageId or messageIds is required" };
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

      const foundHdrs = [];
      const notFound = [];
      for (const msgId of messageIds) {
        if (typeof msgId !== "string" || !msgId) { notFound.push(msgId); continue; }
        const hdr = lookupMsgHdr(db, msgId);
        if (hdr) { foundHdrs.push(hdr); } else { notFound.push(msgId); }
      }

      if (foundHdrs.length === 0) {
        return { error: "No matching messages found" };
      }

      const actions = [];

      if (read !== undefined) {
        for (const hdr of foundHdrs) hdr.markRead(read);
        actions.push({ type: "read", value: read });
      }

      if (flagged !== undefined) {
        for (const hdr of foundHdrs) hdr.markFlagged(flagged);
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
        actions.push({ type: isCopy ? "copy" : "move", to: targetFolder.URI });
      }

      const result = { message: `Requested update of ${foundHdrs.length} message(s)`, updated: foundHdrs.length, actions, accountId: getAccountId(folder) };
      if (notFound.length > 0) result.notFound = notFound;
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  return {
    listAccounts,
    listFolders,
    searchMessages,
    getMessage,
    deleteMessages,
    updateMessage,
  };
}
