/* global Ci */
"use strict";

/**
 * RSS/Atom feed management tools.
 *
 * Thunderbird stores feeds as messages in special RSS account folders.
 * Existing searchMessages/getMessage tools already read feed content;
 * this module adds subscription management (list, subscribe, unsubscribe, refresh).
 */

export function createFeedHandlers({ MailServices, Services, Ci, ChromeUtils, utils, FeedUtils }) {
  const { mcpDebug, resolveFolder, resolveAccount } = utils;

  /**
   * Get the subscriptions database for a server and return all entries.
   */
  function getSubscriptions(server) {
    const ds = FeedUtils.getSubscriptionsDS(server);
    return ds.data || [];
  }

  /**
   * Find all RSS server root folders, optionally filtered by accountId.
   */
  function getRssRootFolders(accountId) {
    if (accountId) {
      const account = resolveAccount(accountId);
      if (!account || account.incomingServer.type !== "rss") {
        return [];
      }
      return [account.incomingServer.rootFolder];
    }
    return FeedUtils.getAllRssServerRootFolders();
  }

  /**
   * Collect all feed subscriptions across an account's folders.
   */
  function collectFeeds(rootFolder) {
    const server = rootFolder.server;
    const subs = getSubscriptions(server);
    return subs.map(sub => ({
      url: sub.url,
      title: sub.title || null,
      destFolder: sub.destFolder,
    }));
  }

  // ── Handlers ──────────────────────────────────────────────────────

  function createFeedAccount(args) {
    mcpDebug("createFeedAccount", {});
    if (!FeedUtils) {
      return { error: "Feed module not available" };
    }
    const { name } = args;
    const account = FeedUtils.createRssAccount(name || undefined);
    return {
      message: "RSS account created",
      accountId: account.key,
      name: account.incomingServer.prettyName,
      rootFolderURI: account.incomingServer.rootFolder.URI,
    };
  }

  function listFeeds(args) {
    if (!FeedUtils) {
      return { error: "Feed module not available" };
    }
    const { accountId, folderPath } = args;

    // If a specific folder is given, list feeds in that folder only
    if (folderPath) {
      const folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }
      if (folder.server.type !== "rss") {
        return { error: "Folder is not in an RSS account" };
      }
      const urls = FeedUtils.getFeedUrlsInFolder(folder);
      if (!urls) {
        return [];
      }
      return urls.map(url => ({ url, destFolder: folder.URI }));
    }

    // Otherwise list all feeds across matching RSS accounts
    const rootFolders = getRssRootFolders(accountId);
    const allFeeds = [];
    for (const rf of rootFolders) {
      allFeeds.push(...collectFeeds(rf));
    }
    return allFeeds;
  }

  /**
   * Wait for any pending feed downloads to finish before subscribing,
   * since FeedUtils.subscribeToFeed silently aborts if downloads are
   * already in progress.
   */
  function waitForPendingDownloads(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      function check() {
        if (FeedUtils.progressNotifier.mNumPendingFeedDownloads <= 0) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Timed out waiting for pending feed downloads to finish"));
          return;
        }
        Services.tm.dispatchToMainThread({ run: check });
      }
      check();
    });
  }

  async function subscribeFeed(args) {
    mcpDebug("subscribeFeed", { url: args?.url, accountId: args?.accountId });
    if (!FeedUtils) {
      return { error: "Feed module not available" };
    }
    const { url, accountId, folderPath } = args;
    if (!url) {
      return { error: "Missing required field: url" };
    }

    let folder = null;
    if (folderPath) {
      folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }
    } else if (accountId) {
      const account = resolveAccount(accountId);
      if (!account || account.incomingServer.type !== "rss") {
        return { error: `RSS account not found: ${accountId}` };
      }
      folder = account.incomingServer.rootFolder;
    }
    // If neither provided, subscribeToFeed will pick the first RSS account
    // or create one automatically.

    // Check for duplicates before attempting subscription
    if (folder) {
      const normalizedUrl = url.replace(/^feed:\x2f\x2f/i, "http://").replace(/^feed:/i, "");
      if (FeedUtils.feedAlreadyExists(normalizedUrl, folder.server)) {
        return { error: "Feed is already subscribed in this account" };
      }
    }

    // Wait for any in-progress downloads to finish first
    try {
      await waitForPendingDownloads();
    } catch (e) {
      return { error: e.message };
    }

    FeedUtils.subscribeToFeed(url, folder);
    return {
      message: "Feed subscription initiated. Items will appear in the feed's folder once downloaded.",
      url,
    };
  }

  function unsubscribeFeed(args) {
    mcpDebug("unsubscribeFeed", { url: args?.url });
    if (!FeedUtils) {
      return { error: "Feed module not available" };
    }
    const { url, folderPath } = args;
    if (!url) {
      return { error: "Missing required field: url" };
    }

    // We need to find the feed's folder to construct a Feed object for deletion.
    // Look through all RSS accounts' subscription databases.
    const rootFolders = FeedUtils.getAllRssServerRootFolders();
    let targetServer = null;
    let targetSub = null;

    for (const rf of rootFolders) {
      if (folderPath) {
        // If folderPath is specified, only look in that account
        const folder = resolveFolder(folderPath);
        if (!folder || folder.server !== rf.server) {
          continue;
        }
      }
      const subs = getSubscriptions(rf.server);
      const match = subs.find(s => s.url === url);
      if (match) {
        targetServer = rf.server;
        targetSub = match;
        break;
      }
    }

    if (!targetSub) {
      return { error: `Feed not found: ${url}` };
    }

    // If the feed never successfully subscribed (no destFolder), just remove
    // it from the database directly.
    const destFolder = targetSub.destFolder
      ? MailServices.folderLookup.getFolderForURL(targetSub.destFolder)
      : null;

    if (destFolder) {
      const { Feed } = ChromeUtils.importESModule("resource:///modules/Feed.sys.mjs");
      const feed = new Feed(url, destFolder);
      FeedUtils.deleteFeed(feed);

      // Also remove the folder if no other feeds use it
      const remainingUrls = FeedUtils.getFeedUrlsInFolder(destFolder);
      if (!remainingUrls || remainingUrls.length === 0) {
        destFolder.parent.propagateDelete(destFolder, true, null);
      }
    } else {
      // No folder — just remove the entry from the subscriptions database
      const ds = FeedUtils.getSubscriptionsDS(targetServer);
      ds.data = ds.data.filter(s => s.url !== url);
      ds.saveSoon();
    }

    return {
      message: "Feed unsubscribed",
      url,
      folder: targetSub.destFolder,
    };
  }

  function refreshFeeds(args) {
    mcpDebug("refreshFeeds", { folderPath: args?.folderPath, accountId: args?.accountId });
    if (!FeedUtils) {
      return { error: "Feed module not available" };
    }
    const { accountId, folderPath } = args;

    let folder;
    if (folderPath) {
      folder = resolveFolder(folderPath);
      if (!folder) {
        return { error: `Folder not found: ${folderPath}` };
      }
    } else if (accountId) {
      const account = resolveAccount(accountId);
      if (!account || account.incomingServer.type !== "rss") {
        return { error: `RSS account not found: ${accountId}` };
      }
      folder = account.incomingServer.rootFolder;
    } else {
      // Refresh all RSS accounts
      const rootFolders = FeedUtils.getAllRssServerRootFolders();
      if (rootFolders.length === 0) {
        return { error: "No RSS accounts found" };
      }
      for (const rf of rootFolders) {
        FeedUtils.downloadFeed(rf, null, false, null);
      }
      return {
        message: `Feed refresh initiated for ${rootFolders.length} ${rootFolders.length === 1 ? "account" : "accounts"}`,
      };
    }

    FeedUtils.downloadFeed(folder, null, false, null);
    return {
      message: "Feed refresh initiated",
      folder: folder.URI,
    };
  }

  return {
    createFeedAccount,
    listFeeds,
    subscribeFeed,
    unsubscribeFeed,
    refreshFeeds,
  };
}
