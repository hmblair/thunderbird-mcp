/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci */
"use strict";

/**
 * Thunderbird MCP Server Extension
 * Exposes email, calendar, and contacts via MCP protocol over HTTP.
 *
 * Architecture: MCP Client <-> mcp-bridge.cjs (stdio<->HTTP) <-> This extension (port 8765)
 *
 * Key quirks documented in domain modules:
 * - MIME header decoding (mime2Decoded* properties)
 * - HTML body charset handling (emojis require HTML entity encoding)
 * - Compose window body preservation (must use New type, not Reply)
 * - IMAP folder sync (msgDatabase may be stale)
 */

const resProto = Cc[
  "@mozilla.org/network/protocol;1?name=resource"
].getService(Ci.nsISubstitutingProtocolHandler);

const MCP_PORT = 8765;

var mcpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const extensionRoot = context.extension.rootURI;
    const resourceName = "thunderbird-mcp";

    resProto.setSubstitutionWithFlags(
      resourceName,
      extensionRoot,
      resProto.ALLOW_CONTENT_ACCESS
    );

    return {
      mcpServer: {
        start: async function() {
          // Guard against double-start on extension reload (port conflict)
          if (globalThis.__tbMcpStartPromise) {
            return await globalThis.__tbMcpStartPromise;
          }
          const startPromise = (async () => {
          try {
            const { HttpServer } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/httpd.sys.mjs?" + Date.now()
            );
            const { NetUtil } = ChromeUtils.importESModule(
              "resource://gre/modules/NetUtil.sys.mjs"
            );
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );

            // Read version from manifest
            const manifestUri = Services.io.newURI("resource://thunderbird-mcp/manifest.json");
            const manifestChannel = NetUtil.newChannel({ uri: manifestUri, loadUsingSystemPrincipal: true });
            const manifestStream = manifestChannel.open();
            const manifestJson = NetUtil.readInputStreamToString(manifestStream, manifestStream.available(), { charset: "UTF-8" });
            manifestStream.close();
            const SERVER_VERSION = JSON.parse(manifestJson).version;

            // Load tool definitions from shared JSON file
            let tools;
            try {
              console.log("[thunderbird-mcp]","Loading tools.json...");
              const toolsUri = Services.io.newURI("resource://thunderbird-mcp/mcp_server/tools.json");
              const toolsChannel = NetUtil.newChannel({
                uri: toolsUri,
                loadUsingSystemPrincipal: true,
              });
              const toolsStream = toolsChannel.open();
              const toolsJson = NetUtil.readInputStreamToString(toolsStream, toolsStream.available(), { charset: "UTF-8" });
              toolsStream.close();
              tools = JSON.parse(toolsJson);
              console.log("[thunderbird-mcp]",`Loaded ${tools.length} tools`);
            } catch (e) {
              console.log("[thunderbird-mcp]",`Failed to load tools.json: ${e}`);
              throw e;
            }

            // Generate auth token and write to ~/.thunderbird-mcp-token
            let authToken;
            try {
              console.log("[thunderbird-mcp]","Generating auth token...");
              const rng = Cc["@mozilla.org/security/random-generator;1"].getService(Ci.nsIRandomGenerator);
              const tokenBytes = rng.generateRandomBytes(32);
              authToken = Array.from(tokenBytes, b => b.toString(16).padStart(2, '0')).join('');
              console.log("[thunderbird-mcp]","Token generated, writing to file...");
              const tokenFilePath = Services.dirsvc.get("Home", Ci.nsIFile).path + "/.thunderbird-mcp-token";
              await IOUtils.writeUTF8(tokenFilePath, authToken);
              await IOUtils.setPermissions(tokenFilePath, 0o600);
              console.log("[thunderbird-mcp]","Token file written successfully");
            } catch (e) {
              console.log("[thunderbird-mcp]",`Failed to write auth token: ${e}`);
              throw new Error(`Cannot start without auth token: ${e}`);
            }

            // Load feed modules
            let FeedUtils = null;
            try {
              ({ FeedUtils } = ChromeUtils.importESModule(
                "resource:///modules/FeedUtils.sys.mjs"
              ));
            } catch (e) {
              console.warn("[thunderbird-mcp] feed module not available:", e?.message || e);
            }

            // Load calendar modules
            let cal = null;
            let CalEvent = null;
            let CalTodo = null;
            try {
              const calModule = ChromeUtils.importESModule(
                "resource:///modules/calendar/calUtils.sys.mjs"
              );
              cal = calModule.cal;
              const { CalEvent: CE } = ChromeUtils.importESModule(
                "resource:///modules/CalEvent.sys.mjs"
              );
              CalEvent = CE;
              const { CalTodo: CT } = ChromeUtils.importESModule(
                "resource:///modules/CalTodo.sys.mjs"
              );
              CalTodo = CT;
            } catch (e) {
              console.warn("[thunderbird-mcp] calendar module not available:", e?.message || e);
            }

            // Load domain modules
            const cacheBust = "?" + Date.now();
            const { createUtils } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/utils.sys.mjs" + cacheBust
            );
            const { createMailHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/mail.sys.mjs" + cacheBust
            );
            const { createComposeHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/compose.sys.mjs" + cacheBust
            );
            const { createFolderHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/folders.sys.mjs" + cacheBust
            );
            const { createCalendarHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/calendar.sys.mjs" + cacheBust
            );
            const { createTaskHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/tasks.sys.mjs" + cacheBust
            );
            const { createContactHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/contacts.sys.mjs" + cacheBust
            );
            const { createFeedHandlers } = ChromeUtils.importESModule(
              "resource://thunderbird-mcp/mcp_server/feeds.sys.mjs" + cacheBust
            );

            const utils = createUtils({ MailServices, Services, Cc, Ci, cal });

            const mailHandlers = createMailHandlers({ MailServices, Services, Cc, Ci, NetUtil, ChromeUtils, utils });
            const composeHandlers = createComposeHandlers({ MailServices, Services, Cc, Ci, ChromeUtils, utils });
            const folderHandlers = createFolderHandlers({ MailServices, utils });
            const calendarHandlers = createCalendarHandlers({ Services, cal, CalEvent, ChromeUtils, utils });
            const taskHandlers = createTaskHandlers({ Services, cal, CalTodo, utils });
            const contactHandlers = createContactHandlers({ MailServices });
            const feedHandlers = createFeedHandlers({ MailServices, Services, Ci, ChromeUtils, utils, FeedUtils });

            const handlers = {
              ...mailHandlers,
              ...composeHandlers,
              ...folderHandlers,
              ...calendarHandlers,
              ...taskHandlers,
              ...contactHandlers,
              ...feedHandlers,
            };

            // Map tool names to handler names where they differ
            const toolNameMap = {};

            async function callTool(name, args) {
              // Validate tool exists and check required fields
              const toolDef = tools.find(t => t.name === name);
              if (!toolDef) throw new Error(`Unknown tool: ${name}`);

              const schema = toolDef.inputSchema;
              if (schema && schema.properties) {
                const known = Object.keys(schema.properties);
                const unknown = Object.keys(args).filter(k => !known.includes(k));
                if (unknown.length > 0) {
                  throw new Error(`Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Valid parameters: ${known.join(', ')}`);
                }
              }
              if (schema && schema.required) {
                for (const field of schema.required) {
                  if (args[field] === undefined || args[field] === null) {
                    throw new Error(`Missing required field: ${field}`);
                  }
                  const expectedType = schema.properties?.[field]?.type;
                  if (expectedType === "array") {
                    if (typeof args[field] === "string") {
                      try { args[field] = JSON.parse(args[field]); } catch {}
                    }
                    if (!Array.isArray(args[field])) {
                      throw new Error(`Field "${field}" must be an array, got ${typeof args[field]}`);
                    }
                  } else if (expectedType && typeof args[field] !== expectedType) {
                    throw new Error(`Field "${field}" must be ${expectedType}, got ${typeof args[field]}`);
                  }
                }
              }

              const handlerName = toolNameMap[name] || name;
              const handler = handlers[handlerName];
              if (!handler) throw new Error(`Unknown tool: ${name}`);
              return await handler(args);
            }

            /**
             * CRITICAL: Must specify { charset: "UTF-8" } or emojis/special chars
             * will be corrupted. NetUtil defaults to Latin-1.
             */
            function readRequestBody(request) {
              const stream = request.bodyInputStream;
              return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
            }

            const server = new HttpServer();

            server.registerPathHandler("/", (req, res) => {
              res.processAsync();

              // Validate auth token
              let reqToken = "";
              try { reqToken = req.getHeader("Authorization"); } catch {}
              if (authToken && reqToken !== `Bearer ${authToken}`) {
                res.setStatusLine("1.1", 401, "Unauthorized");
                res.finish();
                return;
              }

              if (req.method !== "POST") {
                res.setStatusLine("1.1", 200, "OK");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Invalid Request" }
                }));
                res.finish();
                return;
              }

              let message;
              try {
                message = JSON.parse(readRequestBody(req));
              } catch {
                res.setStatusLine("1.1", 200, "OK");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Parse error" }
                }));
                res.finish();
                return;
              }

              if (!message || typeof message !== "object" || Array.isArray(message)) {
                res.setStatusLine("1.1", 200, "OK");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Invalid Request" }
                }));
                res.finish();
                return;
              }

              const { id, method, params } = message;

              // Notifications don't expect a response
              if (typeof method === "string" && method.startsWith("notifications/")) {
                res.setStatusLine("1.1", 204, "No Content");
                res.finish();
                return;
              }

              (async () => {
                try {
                  let result;
                  switch (method) {
                    case "initialize":
                      result = {
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: {} },
                        serverInfo: { name: "thunderbird-mcp", version: SERVER_VERSION }
                      };
                      break;
                    case "resources/list":
                      result = { resources: [] };
                      break;
                    case "prompts/list":
                      result = { prompts: [] };
                      break;
                    case "tools/list":
                      result = { tools };
                      break;
                    case "tools/call":
                      if (!params?.name) {
                        throw new Error("Missing tool name");
                      }
                      result = {
                        content: [{
                          type: "text",
                          text: JSON.stringify(await callTool(params.name, params.arguments || {}), null, 2)
                        }]
                      };
                      break;
                    default:
                      res.setStatusLine("1.1", 200, "OK");
                      res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                      res.write(JSON.stringify({
                        jsonrpc: "2.0",
                        id: id ?? null,
                        error: { code: -32601, message: "Method not found" }
                      }));
                      res.finish();
                      return;
                  }
                  res.setStatusLine("1.1", 200, "OK");
                  // charset=utf-8 is critical for proper emoji handling in responses
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
                } catch (e) {
                  res.setStatusLine("1.1", 200, "OK");
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(JSON.stringify({
                    jsonrpc: "2.0",
                    id: id ?? null,
                    error: { code: -32000, message: e.toString() }
                  }));
                }
                res.finish();
              })();
            });

            console.log("[thunderbird-mcp]","Starting HTTP server...");
            server.start(MCP_PORT);
            console.log("[thunderbird-mcp]",`Server listening on port ${MCP_PORT}`);
            globalThis.__tbMcpHttpServer = server;
            return { success: true, port: MCP_PORT };
          } catch (e) {
            console.log("[thunderbird-mcp]",`FATAL: ${e}\n${e.stack || ""}`);
            console.error("Failed to start MCP server:", e);
            // Clear cached promise so a retry can attempt to bind again
            globalThis.__tbMcpStartPromise = null;
            return { success: false, error: e.toString() };
          }
          })();
          globalThis.__tbMcpStartPromise = startPromise;
          return await startPromise;
        }
      }
    };
  }

  onShutdown(isAppShutdown) {
    try {
      if (globalThis.__tbMcpHttpServer) {
        globalThis.__tbMcpHttpServer.stop(() => {});
        globalThis.__tbMcpHttpServer = null;
        globalThis.__tbMcpStartPromise = null;
        console.log("[thunderbird-mcp]", "HTTP server stopped");
      }
    } catch (e) {
      console.warn("[thunderbird-mcp]", "Error stopping HTTP server:", e);
    }
    if (isAppShutdown) return;
    resProto.setSubstitution("thunderbird-mcp", null);
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }
};
