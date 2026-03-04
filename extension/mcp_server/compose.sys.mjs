// compose.sys.mjs — Compose tools: sendMail, replyToMessage, forwardMessage

export function createComposeHandlers({ MailServices, Services, Cc, Ci, ChromeUtils, utils }) {
  const {
    mcpWarn, escapeHtml, formatBodyHtml, findMessage, addAttachments, setComposeIdentity, formatLocalJsDate,
  } = utils;

  function composeMail(args) {
    const { to, subject, body, cc, bcc, isHtml, from, attachments } = args;
    try {
      const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
        .getService(Ci.nsIMsgComposeService);

      const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);

      const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);

      composeFields.to = to || "";
      composeFields.cc = cc || "";
      composeFields.bcc = bcc || "";
      composeFields.subject = subject || "";

      const formatted = formatBodyHtml(body, isHtml);
      if (isHtml && formatted.includes('<html')) {
        composeFields.body = formatted;
      } else {
        composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${formatted}</body></html>`;
      }

      const attResult = addAttachments(composeFields, attachments);

      msgComposeParams.type = Ci.nsIMsgCompType.New;
      msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
      msgComposeParams.composeFields = composeFields;

      const identityWarning = setComposeIdentity(msgComposeParams, from, null);

      msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

      let msg = "Compose window opened";
      if (identityWarning) msg += ` (${identityWarning})`;
      if (attResult.failed.length > 0) {
        msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
      }
      return { success: true, message: msg };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function replyToMessage(args) {
    const { messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments } = args;
    return new Promise((resolve) => {
      try {
        const found = findMessage(messageId, folderPath);
        if (found.error) {
          resolve({ error: found.error });
          return;
        }
        const { msgHdr, folder } = found;

        const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
          "resource:///modules/gloda/MimeMessage.sys.mjs"
        );

        MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
          try {
            let originalBody = "";
            if (aMimeMsg) {
              try {
                originalBody = aMimeMsg.coerceBodyToPlaintext() || "";
              } catch (e) { mcpWarn("reply body extraction", e);
                originalBody = "";
              }
            }

            const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
              .getService(Ci.nsIMsgComposeService);

            const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
              .createInstance(Ci.nsIMsgComposeParams);

            const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
              .createInstance(Ci.nsIMsgCompFields);

            if (replyAll) {
              composeFields.to = to || msgHdr.author;
              const splitAddresses = (s) => (s || "").match(/(?:[^,"]|"[^"]*")+/g) || [];
              const extractEmail = (s) => (s.match(/<([^>]+)>/)?.[1] || s.trim()).toLowerCase();
              const ownAccount = MailServices.accounts.findAccountForServer(folder.server);
              const ownEmail = (ownAccount?.defaultIdentity?.email || "").toLowerCase();
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
              if (cc) {
                composeFields.cc = cc;
              } else if (uniqueRecipients.length > 0) {
                composeFields.cc = uniqueRecipients.join(", ");
              }
            } else {
              composeFields.to = to || msgHdr.author;
              if (cc) composeFields.cc = cc;
            }

            composeFields.bcc = bcc || "";

            const origSubject = msgHdr.subject || "";
            composeFields.subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;

            composeFields.references = `<${messageId}>`;
            composeFields.setHeader("In-Reply-To", `<${messageId}>`);

            const dateStr = msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : "";
            const author = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
            const quotedLines = originalBody.split('\n').map(line =>
              `&gt; ${escapeHtml(line)}`
            ).join('<br>');
            const quoteBlock = `<br><br>On ${dateStr}, ${escapeHtml(author)} wrote:<br>${quotedLines}`;

            composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${formatBodyHtml(body, isHtml)}${quoteBlock}</body></html>`;

            const attResult = addAttachments(composeFields, attachments);

            msgComposeParams.type = Ci.nsIMsgCompType.New;
            msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
            msgComposeParams.composeFields = composeFields;

            const identityWarning = setComposeIdentity(msgComposeParams, from, folder.server);

            msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

            let msg = "Reply window opened";
            if (identityWarning) msg += ` (${identityWarning})`;
            if (attResult.failed.length > 0) {
              msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
            }
            resolve({ success: true, message: msg });
          } catch (e) {
            resolve({ error: e.toString() });
          }
        }, true, { examineEncryptedParts: true });

      } catch (e) {
        resolve({ error: e.toString() });
      }
    });
  }

  function forwardMessage(args) {
    const { messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments } = args;
    return new Promise((resolve) => {
      try {
        const found = findMessage(messageId, folderPath);
        if (found.error) {
          resolve({ error: found.error });
          return;
        }
        const { msgHdr, folder } = found;

        const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
          "resource:///modules/gloda/MimeMessage.sys.mjs"
        );

        MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
          try {
            const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
              .getService(Ci.nsIMsgComposeService);

            const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
              .createInstance(Ci.nsIMsgComposeParams);

            const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
              .createInstance(Ci.nsIMsgCompFields);

            composeFields.to = to;
            composeFields.cc = cc || "";
            composeFields.bcc = bcc || "";

            const origSubject = msgHdr.subject || "";
            composeFields.subject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`;

            let originalBody = "";
            if (aMimeMsg) {
              try {
                originalBody = aMimeMsg.coerceBodyToPlaintext() || "";
              } catch (e) { mcpWarn("forward body extraction", e);
                originalBody = "";
              }
            }

            const dateStr = msgHdr.date ? formatLocalJsDate(new Date(msgHdr.date / 1000)) : "";
            const fwdAuthor = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
            const fwdSubject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
            const fwdRecipients = msgHdr.mime2DecodedRecipients || msgHdr.recipients || "";
            const escapedBody = escapeHtml(originalBody).replace(/\n/g, '<br>');

            const forwardBlock = `-------- Forwarded Message --------<br>` +
              `Subject: ${escapeHtml(fwdSubject)}<br>` +
              `Date: ${dateStr}<br>` +
              `From: ${escapeHtml(fwdAuthor)}<br>` +
              `To: ${escapeHtml(fwdRecipients)}<br><br>` +
              escapedBody;

            const introHtml = body ? formatBodyHtml(body, isHtml) + '<br><br>' : "";

            composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${introHtml}${forwardBlock}</body></html>`;

            let origAttCount = 0;
            if (aMimeMsg && aMimeMsg.allUserAttachments) {
              for (const att of aMimeMsg.allUserAttachments) {
                try {
                  const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
                    .createInstance(Ci.nsIMsgAttachment);
                  attachment.url = att.url;
                  attachment.name = att.name;
                  attachment.contentType = att.contentType;
                  composeFields.addAttachment(attachment);
                  origAttCount++;
                } catch (e) { mcpWarn("forward attachment copy", e);
                }
              }
            }

            const attResult = addAttachments(composeFields, attachments);

            msgComposeParams.type = Ci.nsIMsgCompType.New;
            msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
            msgComposeParams.composeFields = composeFields;

            const identityWarning = setComposeIdentity(msgComposeParams, from, folder.server);

            msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

            let msg = `Forward window opened with ${origAttCount + attResult.added} attachment(s)`;
            if (identityWarning) msg += ` (${identityWarning})`;
            if (attResult.failed.length > 0) {
              msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
            }
            resolve({ success: true, message: msg });
          } catch (e) {
            resolve({ error: e.toString() });
          }
        }, true, { examineEncryptedParts: true });

      } catch (e) {
        resolve({ error: e.toString() });
      }
    });
  }

  return {
    sendMail: composeMail,
    replyToMessage,
    forwardMessage,
  };
}
