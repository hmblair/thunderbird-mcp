// compose.sys.mjs — Compose tool: createDraft (fully headless)

export function createComposeHandlers({ MailServices, Services, Cc, Ci, ChromeUtils, utils }) {
  const {
    mcpWarn, mcpDebug, findMessage, formatLocalJsDate,
    findIdentity, findDraftsFolder, findSentFolder, folderShortPath,
  } = utils;

  // Strip CR/LF from header values to prevent MIME header injection
  function sanitizeHeader(value) {
    return String(value).replace(/[\r\n]+/g, ' ');
  }

  function buildMimeMessage({ to, subject, body, cc, bcc, isHtml, from, inReplyTo, references, attachments }) {
    mcpDebug("buildMimeMessage", { from, to, subject });
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const hasAttachments = attachments && attachments.length > 0;

    const lines = [];
    if (from) lines.push(`From: ${sanitizeHeader(from)}`);
    lines.push(`To: ${sanitizeHeader(to || "")}`);
    if (cc) lines.push(`Cc: ${sanitizeHeader(cc)}`);
    if (bcc) lines.push(`Bcc: ${sanitizeHeader(bcc)}`);
    lines.push(`Subject: ${sanitizeHeader(subject || "")}`);
    lines.push("MIME-Version: 1.0");
    lines.push(`Date: ${new Date().toUTCString()}`);
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@thunderbird-mcp>`;
    lines.push(`Message-ID: ${msgId}`);
    if (inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeader(inReplyTo)}`);
    if (references) lines.push(`References: ${sanitizeHeader(references)}`);

    if (hasAttachments) {
      lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      lines.push("");
      lines.push(`--${boundary}`);
      const contentType = isHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
      lines.push(`Content-Type: ${contentType}`);
      lines.push("");
      lines.push(body || "");

      for (const att of attachments) {
        lines.push(`--${boundary}`);
        const safeName = sanitizeHeader(att.name).replace(/"/g, '\\"');
        lines.push(`Content-Type: ${sanitizeHeader(att.contentType || "application/octet-stream")}; name="${safeName}"`);
        lines.push("Content-Transfer-Encoding: base64");
        lines.push(`Content-Disposition: attachment; filename="${safeName}"`);
        lines.push("");
        lines.push(att.base64Data);
      }
      lines.push(`--${boundary}--`);
    } else {
      const contentType = isHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
      lines.push(`Content-Type: ${contentType}`);
      lines.push("");
      lines.push(body || "");
    }

    return lines.join("\r\n");
  }

  function readFileAsBase64(filePath) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(filePath);
    if (!file.exists()) return null;

    const stream = Cc["@mozilla.org/network/file-input-stream;1"]
      .createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0, 0);

    const binaryStream = Cc["@mozilla.org/binaryinputstream;1"]
      .createInstance(Ci.nsIBinaryInputStream);
    binaryStream.setInputStream(stream);

    const bytes = binaryStream.readBytes(binaryStream.available());
    binaryStream.close();

    // btoa for base64 encoding, split into 76-char lines per RFC 2045
    const raw = btoa(bytes);
    return raw.match(/.{1,76}/g).join("\r\n");
  }

  function resolveAttachments(filePaths) {
    const result = { attachments: [], failed: [] };
    if (!filePaths || !Array.isArray(filePaths)) return result;

    const mimeTypes = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".txt": "text/plain",
      ".html": "text/html",
      ".csv": "text/csv",
      ".json": "application/json",
      ".xml": "application/xml",
      ".zip": "application/zip",
      ".gz": "application/gzip",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    for (const filePath of filePaths) {
      try {
        const base64Data = readFileAsBase64(filePath);
        if (!base64Data) {
          result.failed.push(filePath);
          continue;
        }
        const name = filePath.split("/").pop();
        const ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
        result.attachments.push({
          name,
          contentType: mimeTypes[ext] || "application/octet-stream",
          base64Data,
        });
      } catch (e) {
        mcpWarn("attachment read", e);
        result.failed.push(filePath);
      }
    }
    return result;
  }

  function saveDraftToFolder(mime, draftsFolder) {
    const tmpFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tmpFile.append("thunderbird-mcp-draft.eml");
    tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    const foStream = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    foStream.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);
    const converter = Cc["@mozilla.org/intl/converter-output-stream;1"]
      .createInstance(Ci.nsIConverterOutputStream);
    converter.init(foStream, "UTF-8");
    converter.writeString(mime);
    converter.close();

    const copyListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      OnStartCopy() {},
      OnProgress(progress, progressMax) {},
      SetMessageKey(key) {},
      GetMessageId() { return ""; },
      OnStopCopy(status) {
        try { tmpFile.remove(false); } catch {}
      },
    };

    MailServices.copy.copyFileMessage(
      tmpFile, draftsFolder, null, true,
      Ci.nsMsgMessageFlags.Read, "", copyListener, null
    );
  }

  function resolveIdentityAndDrafts(from, fallbackServer) {
    mcpDebug("resolveIdentityAndDrafts", { from, fallbackServer: fallbackServer?.hostName || null });
    const identity = findIdentity(from) || (() => {
      if (fallbackServer) {
        const acct = MailServices.accounts.findAccountForServer(fallbackServer);
        mcpDebug("resolveIdentityAndDrafts fallback", { server: fallbackServer.hostName, account: acct?.key });
        return acct?.defaultIdentity;
      }
      return null;
    })() || MailServices.accounts.defaultAccount?.defaultIdentity;

    // Find the account that owns this identity
    let account = null;
    if (identity) {
      for (const acct of MailServices.accounts.accounts) {
        for (const id of acct.identities) {
          if (id.key === identity.key) {
            account = acct;
            break;
          }
        }
        if (account) break;
      }
    }
    if (!account) account = MailServices.accounts.defaultAccount;
    const draftsFolder = findDraftsFolder(account || MailServices.accounts.defaultAccount);

    mcpDebug("resolveIdentityAndDrafts result", { identity: identity?.email, account: account?.key, draftsFolder: draftsFolder?.URI });
    return { identity, draftsFolder };
  }

  function createDraft(args) {
    const { to, subject, body, cc, bcc, isHtml, from, messageId, folderPath, replyAll, forward, attachments } = args;
    mcpDebug("createDraft", { from, to, subject, messageId, folderPath, replyAll, forward });

    // Reply or forward mode: need to fetch original message asynchronously
    if (messageId && folderPath) {
      return new Promise((resolve) => {
        try {
          const found = findMessage(messageId, folderPath);
          if (found.error) {
            resolve({ error: found.error });
            return;
          }
          const { msgHdr, folder } = found;

          const { identity, draftsFolder } = resolveIdentityAndDrafts(from, folder.server);
          if (!draftsFolder) {
            resolve({ error: "Could not find Drafts folder" });
            return;
          }

          const attResult = resolveAttachments(attachments);

          const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
            "resource:///modules/gloda/MimeMessage.sys.mjs"
          );

          MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
            try {
              let originalBody = "";
              if (aMimeMsg) {
                try {
                  originalBody = aMimeMsg.coerceBodyToPlaintext() || "";
                } catch (e) { mcpWarn("draft body extraction", e); }
              }

              if (forward) {
                // --- Forward mode ---
                const origSubject = msgHdr.subject || "";
                const fwdSubject = subject || (origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`);

                const dateStr = msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : "";
                const fwdAuthor = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                const fwdSubjectDecoded = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
                const fwdRecipients = msgHdr.mime2DecodedRecipients || msgHdr.recipients || "";

                const forwardBlock =
                  `\n\n-------- Forwarded Message --------\n` +
                  `Subject: ${fwdSubjectDecoded}\n` +
                  `Date: ${dateStr}\n` +
                  `From: ${fwdAuthor}\n` +
                  `To: ${fwdRecipients}\n\n` +
                  originalBody;

                const fullBody = (body || "") + forwardBlock;

                // Carry over original attachments
                if (aMimeMsg && aMimeMsg.allUserAttachments) {
                  for (const att of aMimeMsg.allUserAttachments) {
                    try {
                      // Resolve attachment URL to a local temp file via NetUtil-style fetch
                      // For MIME-embedded attachments, the URL is a mailbox:// or imap:// URL
                      // We include them as-is if we can read them; skip on failure
                      const uri = Services.io.newURI(att.url);
                      const channel = Services.io.newChannelFromURI(uri, null,
                        Services.scriptSecurityManager.getSystemPrincipal(), null,
                        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                        Ci.nsIContentPolicy.TYPE_OTHER);
                      const inputStream = channel.open();
                      const binaryStream = Cc["@mozilla.org/binaryinputstream;1"]
                        .createInstance(Ci.nsIBinaryInputStream);
                      binaryStream.setInputStream(inputStream);
                      const bytes = binaryStream.readBytes(binaryStream.available());
                      binaryStream.close();
                      const raw = btoa(bytes);
                      const base64Data = raw.match(/.{1,76}/g).join("\r\n");
                      attResult.attachments.push({
                        name: att.name,
                        contentType: att.contentType || "application/octet-stream",
                        base64Data,
                      });
                    } catch (e) { mcpWarn("forward attachment carry-over", e); }
                  }
                }

                const mime = buildMimeMessage({
                  to: to || "", subject: fwdSubject, body: fullBody,
                  cc: cc || "", bcc: bcc || "", isHtml: false,
                  from: identity?.email,
                  attachments: attResult.attachments,
                });

                saveDraftToFolder(mime, draftsFolder);
                let msg = "Requested save of forward draft to Drafts folder";
                if (attResult.failed.length > 0) {
                  msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
                }
                resolve({
                  message: msg,
                  draftsFolder: folderShortPath(draftsFolder),
                });

              } else {
                // --- Reply mode ---
                let replyTo = to || msgHdr.author;
                let replyCc = cc || "";
                if (replyAll && !cc) {
                  const splitAddresses = (s) => (s || "").match(/(?:[^,"]|"[^"]*")+/g) || [];
                  const extractEmail = (s) => (s.match(/<([^>]+)>/)?.[1] || s.trim()).toLowerCase();
                  const ownEmail = (identity?.email || "").toLowerCase();
                  const allRecipients = [
                    ...splitAddresses(msgHdr.recipients),
                    ...splitAddresses(msgHdr.ccList)
                  ]
                    .map(r => r.trim())
                    .filter(r => r && (!ownEmail || extractEmail(r) !== ownEmail));
                  const seen = new Set();
                  const uniqueRecipients = allRecipients.filter(r => {
                    const email = extractEmail(r);
                    if (seen.has(email)) return false;
                    seen.add(email);
                    return true;
                  });
                  if (uniqueRecipients.length > 0) {
                    replyCc = uniqueRecipients.join(", ");
                  }
                }

                const origSubject = msgHdr.subject || "";
                const replySubject = subject || (origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`);

                const dateStr = msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : "";
                const author = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                const quotedLines = originalBody.split('\n').map(line => `> ${line}`).join('\n');
                const quoteBlock = `\n\nOn ${dateStr}, ${author} wrote:\n${quotedLines}`;
                const fullBody = (body || "") + quoteBlock;

                const fullMsgId = msgHdr.messageId;
                const inReplyTo = `<${fullMsgId}>`;
                const references = `<${fullMsgId}>`;

                const mime = buildMimeMessage({
                  to: replyTo, subject: replySubject, body: fullBody,
                  cc: replyCc, bcc: bcc || "", isHtml: false,
                  from: identity?.email, inReplyTo, references,
                  attachments: attResult.attachments,
                });

                saveDraftToFolder(mime, draftsFolder);
                let msg = "Requested save of reply draft to Drafts folder";
                if (attResult.failed.length > 0) {
                  msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
                }
                resolve({
                  message: msg,
                  draftsFolder: folderShortPath(draftsFolder),
                });
              }
            } catch (e) {
              resolve({ error: e.toString() });
            }
          }, true, { examineEncryptedParts: true });

        } catch (e) {
          resolve({ error: e.toString() });
        }
      });
    }

    // Simple draft mode (no reply/forward)
    try {
      const { identity, draftsFolder } = resolveIdentityAndDrafts(from, null);
      if (!draftsFolder) {
        return { error: "Could not find Drafts folder" };
      }

      const attResult = resolveAttachments(attachments);

      const mime = buildMimeMessage({
        to, subject, body, cc, bcc, isHtml,
        from: from || identity?.email,
        attachments: attResult.attachments,
      });

      saveDraftToFolder(mime, draftsFolder);
      let msg = "Requested save of draft to Drafts folder";
      if (attResult.failed.length > 0) {
        msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
      }
      return {
        message: msg,
        draftsFolder: folderShortPath(draftsFolder),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function sendDraft(args) {
    const { messageId, folderPath } = args;
    mcpDebug("sendDraft", { messageId, folderPath });
    return new Promise((resolve) => {
      try {
        const found = findMessage(messageId, folderPath);
        if (found.error) {
          resolve({ error: found.error });
          return;
        }
        const { msgHdr, folder } = found;

        // Resolve identity from the folder's account (not the draft's From header,
        // which may be mangled by EWS/Exchange indexing)
        const folderAccount = MailServices.accounts.findAccountForServer(folder.server);
        const identity = folderAccount?.defaultIdentity
          || MailServices.accounts.defaultAccount?.defaultIdentity;
        mcpDebug("sendDraft identity", {
          folderServer: folder.server?.hostName,
          folderAccount: folderAccount?.key,
          identity: identity?.email,
          author: msgHdr.mime2DecodedAuthor || msgHdr.author,
        });
        if (!identity) {
          resolve({ error: "Could not determine sender identity" });
          return;
        }
        const account = MailServices.accounts.findAccountForServer(
          identity.incomingServer || folder.server
        ) || MailServices.accounts.defaultAccount;

        // Stream the raw message to a temp file
        const streamUri = msgHdr.folder.getUriForMsg(msgHdr);
        const msgService = MailServices.messageServiceFromURI(streamUri);

        const tmpFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
        tmpFile.append("thunderbird-mcp-send.eml");
        tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

        const foStream = Cc["@mozilla.org/network/file-output-stream;1"]
          .createInstance(Ci.nsIFileOutputStream);
        foStream.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);

        const streamListener = {
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
          onStartRequest() {},
          onDataAvailable(request, inputStream, offset, count) {
            const scriptableStream = Cc["@mozilla.org/scriptableinputstream;1"]
              .createInstance(Ci.nsIScriptableInputStream);
            scriptableStream.init(inputStream);
            const data = scriptableStream.read(count);
            foStream.write(data, data.length);
          },
          onStopRequest(request, statusCode) {
            foStream.close();

            try {
              // Build compFields from the draft headers
              const compFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                .createInstance(Ci.nsIMsgCompFields);
              compFields.to = msgHdr.mime2DecodedRecipients || msgHdr.recipients || "";
              compFields.cc = msgHdr.ccList || "";
              compFields.bcc = msgHdr.bccList || "";
              compFields.subject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
              compFields.from = identity.email;

              // Set the Sent folder for filing the copy
              if (identity.doFcc) {
                let fcc = identity.fccFolder || "";
                if (!fcc) {
                  const sentFolder = findSentFolder(account);
                  if (sentFolder) fcc = sentFolder.URI;
                }
                compFields.fcc = fcc;
                mcpDebug("sendDraft fcc", { doFcc: true, fcc, account: account?.key });
              }

              // Preserve threading headers
              try {
                const inReplyTo = msgHdr.getStringProperty("inReplyTo");
                if (inReplyTo) compFields.inReplyTo = inReplyTo;
              } catch {}
              try {
                const refs = msgHdr.getStringProperty("references");
                if (refs) compFields.references = refs;
              } catch {}

              const msgSend = Cc["@mozilla.org/messengercompose/send;1"]
                .createInstance(Ci.nsIMsgSend);

              const sendListener = {
                QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener"]),
                onStartSending() {},
                onSendNotPerformed() {},
                onProgress() {},
                onStatus() {},
                onGetDraftFolderURI() {},
                onStopSending(msgID, status) {
                  try { tmpFile.remove(false); } catch {}

                  if (status === 0) {
                    // Delete the draft after successful send
                    try {
                      folder.deleteMessages([msgHdr], null, true, true, null, false);
                    } catch (e) { mcpWarn("draft cleanup", e); }
                    resolve({
                      message: "Message sent",
                    });
                  } else {
                    resolve({ error: `Send failed with status: ${status}` });
                  }
                },
              };

              // nsMsgDeliverNow = 0
              msgSend.sendMessageFile(
                identity, account ? account.key : "", compFields,
                tmpFile, false, false, 0, null,
                sendListener, null, null
              );
            } catch (e) {
              try { tmpFile.remove(false); } catch {}
              resolve({ error: e.toString() });
            }
          },
        };

        msgService.streamMessage(streamUri, streamListener, null, null, false, "", true);
      } catch (e) {
        resolve({ error: e.toString() });
      }
    });
  }

  return {
    createDraft,
    sendDraft,
  };
}
