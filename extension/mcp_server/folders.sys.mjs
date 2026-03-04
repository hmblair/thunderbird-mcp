// folders.sys.mjs — Folder tools: create, rename, delete, move

export function createFolderHandlers({ MailServices, utils }) {
  const { mcpWarn, findTrashFolder } = utils;

  function createFolder(args) {
    const { parentFolderPath, name } = args;
    try {
      if (typeof parentFolderPath !== "string" || !parentFolderPath) {
        return { error: "parentFolderPath must be a non-empty string" };
      }
      if (typeof name !== "string" || !name) {
        return { error: "name must be a non-empty string" };
      }

      const parent = MailServices.folderLookup.getFolderForURL(parentFolderPath);
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
        path: newPath
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

      const folder = MailServices.folderLookup.getFolderForURL(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      folder.rename(newName, null);

      return {
        success: true,
        message: `Folder renamed to "${newName}"`,
        path: folder.URI
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

      const folder = MailServices.folderLookup.getFolderForURL(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      const parent = folder.parent;
      if (!parent) {
        return { error: "Cannot delete a root folder" };
      }

      if (permanent) {
        parent.propagateDelete(folder, true, null);
        return { success: true, message: `Folder permanently deleted` };
      } else {
        const trashFolder = findTrashFolder(folder);
        if (!trashFolder) {
          return { error: "Trash folder not found" };
        }
        parent.propagateDelete(folder, false, null);
        return { success: true, message: `Folder moved to Trash` };
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

      const folder = MailServices.folderLookup.getFolderForURL(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }

      const destParent = MailServices.folderLookup.getFolderForURL(destinationParentPath);
      if (!destParent) {
        return { error: `Destination folder not found: ${destinationParentPath}` };
      }

      MailServices.copy.copyFolder(folder, destParent, true, null, null);

      return {
        success: true,
        message: `Folder moved to "${destParent.prettyName || destParent.name || destinationParentPath}"`
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

      let emptied = 0;
      for (const account of accounts) {
        const root = account.incomingServer?.rootFolder;
        if (!root) continue;
        const trash = findTrashFolder({ server: account.incomingServer });
        if (trash) {
          trash.emptyTrash(null);
          emptied++;
        }
      }

      if (emptied === 0) {
        return { error: "No Trash folders found" };
      }
      return { success: true, message: `Emptied Trash for ${emptied} account(s)` };
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
  };
}
