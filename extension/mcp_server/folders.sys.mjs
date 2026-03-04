// folders.sys.mjs — Folder tools: create, rename, delete, move

export function createFolderHandlers({ MailServices, utils }) {
  const { mcpWarn, resolveFolder, findTrashFolder, findJunkFolder, getAccountId } = utils;

  function createFolder(args) {
    const { parentFolderPath, name } = args;
    try {
      if (typeof parentFolderPath !== "string" || !parentFolderPath) {
        return { error: "parentFolderPath must be a non-empty string" };
      }
      if (typeof name !== "string" || !name) {
        return { error: "name must be a non-empty string" };
      }

      const parent = resolveFolder(parentFolderPath);
      if (!parent) {
        return { error: `Parent folder not found: ${parentFolderPath}` };
      }

      parent.createSubfolder(name, null);

      let newPath = null;
      try {
        if (parent.hasSubFolders) {
          for (const sub of parent.subFolders) {
            if (sub.prettyName === name || sub.name === name) {
              newPath = sub.URI;
              break;
            }
          }
        }
      } catch (e) { mcpWarn("folder creation", e);
      }

      return {
        success: true,
        message: `Folder "${name}" created`,
        path: newPath,
        accountId: getAccountId(parent),
      };
    } catch (e) {
      const msg = e.toString();
      if (msg.includes("NS_MSG_FOLDER_EXISTS")) {
        return { error: `Folder "${name}" already exists under this parent` };
      }
      return { error: msg };
    }
  }

  function renameFolder(args) {
    const { folderPath, newName } = args;
    try {
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }
      if (typeof newName !== "string" || !newName) {
        return { error: "newName must be a non-empty string" };
      }

      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      folder.rename(newName, null);

      return {
        success: true,
        message: `Folder renamed to "${newName}"`,
        path: folder.URI,
        accountId: getAccountId(folder),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function deleteFolder(args) {
    const { folderPath, permanent } = args;
    try {
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }

      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      const parent = folder.parent;
      if (!parent) {
        return { error: "Cannot delete a root folder" };
      }

      const accountId = getAccountId(folder);
      if (permanent) {
        parent.propagateDelete(folder, true, null);
        return { success: true, message: `Folder permanently deleted`, accountId };
      } else {
        const trashFolder = findTrashFolder(folder);
        if (!trashFolder) {
          return { error: "Trash folder not found" };
        }
        parent.propagateDelete(folder, false, null);
        return { success: true, message: `Folder moved to Trash`, accountId };
      }
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function moveFolder(args) {
    const { folderPath, destinationParentPath } = args;
    try {
      if (typeof folderPath !== "string" || !folderPath) {
        return { error: "folderPath must be a non-empty string" };
      }
      if (typeof destinationParentPath !== "string" || !destinationParentPath) {
        return { error: "destinationParentPath must be a non-empty string" };
      }

      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      const destParent = resolveFolder(destinationParentPath);
      if (!destParent) {
        return { error: `Destination folder not found: ${destinationParentPath}` };
      }

      MailServices.copy.copyFolder(folder, destParent, true, null, null);

      return {
        success: true,
        message: `Folder moved to "${destParent.prettyName || destParent.name || destinationParentPath}"`,
        accountId: getAccountId(folder),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function emptyTrash(args) {
    const { accountId } = args || {};
    try {
      const accounts = accountId
        ? [MailServices.accounts.getAccount(accountId)].filter(Boolean)
        : [...MailServices.accounts.accounts];

      if (accounts.length === 0) {
        return { error: accountId ? `Account not found: ${accountId}` : "No accounts found" };
      }

      const results = [];
      for (const account of accounts) {
        const root = account.incomingServer?.rootFolder;
        if (!root) continue;
        const trash = findTrashFolder({ server: account.incomingServer });
        if (trash) {
          const countBefore = trash.getTotalMessages(false);
          trash.emptyTrash(null);
          const countAfter = trash.getTotalMessages(false);
          results.push({ accountId: account.key, folder: trash.URI, messagesDeleted: countBefore - countAfter, countBefore, countAfter });
        }
      }

      if (results.length === 0) {
        return { error: "No Trash folders found" };
      }
      return { success: true, accounts: results };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function emptyJunk(args) {
    const { accountId } = args || {};
    try {
      const accounts = accountId
        ? [MailServices.accounts.getAccount(accountId)].filter(Boolean)
        : [...MailServices.accounts.accounts];

      if (accounts.length === 0) {
        return { error: accountId ? `Account not found: ${accountId}` : "No accounts found" };
      }

      const results = [];
      for (const account of accounts) {
        const junk = findJunkFolder(account);
        if (!junk) continue;
        const msgs = [];
        try {
          const db = junk.msgDatabase;
          if (db) {
            for (const hdr of db.enumerateMessages()) msgs.push(hdr);
          }
        } catch {}
        const countBefore = msgs.length;
        if (msgs.length > 0) {
          junk.deleteMessages(msgs, null, true, false, null, false);
        }
        const countAfter = junk.getTotalMessages(false);
        results.push({ accountId: account.key, folder: junk.URI, messagesDeleted: countBefore - countAfter, countBefore, countAfter });
      }

      if (results.length === 0) {
        return { error: "No Junk folders found" };
      }
      return { success: true, accounts: results };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  return {
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    emptyTrash,
    emptyJunk,
  };
}
