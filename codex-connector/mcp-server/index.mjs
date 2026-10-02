#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.FIGMA_LOCAL_BRIDGE_PORT || "38451", 10);
const MAX_WS_PAYLOAD = 16 * 1024 * 1024;
const MAX_LOCAL_RPC_PAYLOAD = 4 * 1024 * 1024;
const SERVER_VERSION = "0.5.0";
const FIGMA_DESIGN_AI_CLIENT_KEY = "figma-design-ai-local-v1";
const LOCAL_RPC_KEY = "figma-design-ai-shared-bridge-v1";

let rpcMode = "line";
let stdinBuffer = Buffer.alloc(0);
let activeFigmaClient = null;
let latestSelection = null;
let latestSelectionAt = null;
let requestCounter = 0;
let bridgeMode = "starting";
const pendingFigmaRequests = new Map();
const bridgeModeWaiters = new Set();

function stderr(message) {
  process.stderr.write(`[figma-local-bridge] ${message}\n`);
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function setBridgeMode(mode) {
  bridgeMode = mode;
  for (const resolve of bridgeModeWaiters) resolve(mode);
  bridgeModeWaiters.clear();
}

function waitForBridgeMode(timeoutMs = 2500) {
  if (bridgeMode !== "starting") return Promise.resolve(bridgeMode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bridgeModeWaiters.delete(done);
      resolve(bridgeMode);
    }, timeoutMs);
    const done = (mode) => {
      clearTimeout(timer);
      resolve(mode);
    };
    bridgeModeWaiters.add(done);
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_LOCAL_RPC_PAYLOAD) throw new Error("Local bridge request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function probeExistingBridge() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://${HOST}:${PORT}/`, { signal: controller.signal });
    if (!response.ok) return false;
    const info = await response.json();
    return info?.name === "figma-local-bridge" && info?.sharedRpc === true && info?.version === SERVER_VERSION;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function proxyToolCall(name, args) {
  const response = await fetch(`http://${HOST}:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-figma-local-bridge": LOCAL_RPC_KEY
    },
    body: JSON.stringify({ name, args })
  });
  if (!response.ok) throw new Error(`Shared Figma bridge returned HTTP ${response.status}.`);
  const result = await response.json();
  if (!result || !Array.isArray(result.content)) {
    throw new Error("The shared Figma bridge returned an invalid response.");
  }
  return result;
}

function createWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWebSocket(client, message) {
  if (!client || client.socket.destroyed) {
    throw new Error("Figma connection is not available.");
  }
  client.socket.write(createWebSocketFrame(JSON.stringify(message)));
}

function closeWebSocket(client, code = 1000, reason = "") {
  if (!client || client.socket.destroyed) return;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  client.socket.end(createWebSocketFrame(payload, 0x8));
}

function parseWebSocketFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (client.buffer.length < 4) return;
      payloadLength = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (client.buffer.length < 10) return;
      const length = client.buffer.readBigUInt64BE(2);
      if (length > BigInt(MAX_WS_PAYLOAD)) {
        closeWebSocket(client, 1009, "Message too large");
        return;
      }
      payloadLength = Number(length);
      offset = 10;
    }

    if (payloadLength > MAX_WS_PAYLOAD) {
      closeWebSocket(client, 1009, "Message too large");
      return;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + payloadLength) return;

    let mask;
    if (masked) {
      mask = client.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLength));
    client.buffer = client.buffer.subarray(offset + payloadLength);

    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x8) {
      closeWebSocket(client);
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(createWebSocketFrame(payload, 0xA));
      continue;
    }
    if (opcode === 0xA) continue;

    if (opcode === 0x1) {
      client.fragments = [payload];
    } else if (opcode === 0x0 && client.fragments.length > 0) {
      client.fragments.push(payload);
    } else {
      closeWebSocket(client, 1003, "Unsupported frame");
      return;
    }

    if (fin) {
      const text = Buffer.concat(client.fragments).toString("utf8");
      client.fragments = [];
      handleFigmaMessage(client, text);
    }
  }
}

function handleFigmaMessage(client, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    sendWebSocket(client, { type: "error", error: "Invalid JSON message." });
    return;
  }

  if (message.type === "hello") {
    const isFigmaDesignAi = message.clientKey === FIGMA_DESIGN_AI_CLIENT_KEY;
    if (!isFigmaDesignAi) {
      client.paired = false;
      sendWebSocket(client, {
        type: "pair-required",
        message: "This local endpoint accepts only FigLink."
      });
      return;
    }

    if (activeFigmaClient && activeFigmaClient !== client) {
      closeWebSocket(activeFigmaClient, 4001, "Another Figma plugin connected");
    }
    client.paired = true;
    client.clientName = message.clientName || (isFigmaDesignAi ? "FigLink" : "Figma plugin");
    client.figmaVersion = message.figmaVersion || null;
    activeFigmaClient = client;
    sendWebSocket(client, {
      type: "hello-ack",
      protocolVersion: "0.2",
      serverVersion: SERVER_VERSION
    });
    stderr(`${client.clientName} connected.`);
    return;
  }

  if (!client.paired) {
    sendWebSocket(client, { type: "pair-required" });
    return;
  }

  if (message.type === "ping") {
    sendWebSocket(client, { type: "pong", timestamp: message.timestamp || Date.now() });
    return;
  }

  if (message.type === "event" && message.event === "selection-changed") {
    latestSelection = message.payload || null;
    latestSelectionAt = new Date().toISOString();
    return;
  }

  if (message.type === "response" && typeof message.requestId === "string") {
    const pending = pendingFigmaRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFigmaRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Figma rejected the request."));
  }
}

const httpServer = http.createServer(async (request, response) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    response.writeHead(403).end();
    return;
  }

  if (request.method === "POST" && request.url === "/mcp") {
    if (request.headers["x-figma-local-bridge"] !== LOCAL_RPC_KEY) {
      response.writeHead(403).end();
      return;
    }
    try {
      const message = await readJsonBody(request);
      const result = await callToolLocal(message.name, message.args || {});
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(errorResult(error)));
    }
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify({
    name: "figma-local-bridge",
    version: SERVER_VERSION,
    sharedRpc: true,
    connected: Boolean(activeFigmaClient?.paired)
  }));
});

httpServer.on("upgrade", (request, socket) => {
  if (request.url !== "/figma" || !isLoopback(socket.remoteAddress)) {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    paired: false,
    figmaVersion: null
  };

  socket.on("data", (chunk) => parseWebSocketFrames(client, chunk));
  socket.on("error", (error) => stderr(`WebSocket error: ${error.message}`));
  socket.on("close", () => {
    if (activeFigmaClient === client) {
      activeFigmaClient = null;
      for (const [id, pending] of pendingFigmaRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Figma plugin disconnected."));
        pendingFigmaRequests.delete(id);
      }
      stderr("Figma plugin disconnected.");
    }
  });
});

httpServer.on("error", async (error) => {
  if (error.code === "EADDRINUSE") {
    if (await probeExistingBridge()) {
      setBridgeMode("proxy");
      stderr(`Using the existing shared bridge on ${HOST}:${PORT}.`);
      return;
    }
    setBridgeMode("unavailable");
    stderr(`Port ${PORT} is used by an incompatible process. Restart Codex once to upgrade the local bridge.`);
  } else {
    setBridgeMode("unavailable");
    stderr(`Bridge server error: ${error.message}`);
  }
});

httpServer.listen(PORT, HOST, () => {
  setBridgeMode("owner");
  stderr(`Listening on ws://${HOST}:${PORT}/figma`);
});

function requestFigma(command, params = {}) {
  if (!activeFigmaClient?.paired) {
    throw new Error("FigLink is not connected. Run the plugin inside Figma and keep its panel open.");
  }

  const requestId = `req-${Date.now()}-${requestCounter += 1}`;
  const isWrite = command === "create-design" || command === "patch-selection";
  const timeoutMs = isWrite ? 55000 : 20000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFigmaRequests.delete(requestId);
      reject(new Error(isWrite
        ? "Timed out waiting for approval in the Figma plugin."
        : "Timed out waiting for Figma."));
    }, timeoutMs);

    pendingFigmaRequests.set(requestId, { resolve, reject, timer });
    sendWebSocket(activeFigmaClient, {
      type: "command",
      requestId,
      command,
      params
    });
  });
}

const tools = [
  {
    name: "figma_get_design_context",
    description: "Required before implementing a selected Figma frame. Read ALL nested layers in pages, without a depth limit, including layout, geometry, mixed text runs and image/vector asset references. Repeat with nextCursor until complete=true. Do not implement from a screenshot alone.",
    inputSchema: {type:"object",properties:{
      cursor:{type:"string",description:"nextCursor from the preceding page. Restart without a cursor if the document changes."},
      nodeId:{type:"string",description:"Optional selected node or descendant to start a focused read."},
      pageSize:{type:"integer",minimum:1,maximum:150,default:75}
    },additionalProperties:false}
  },
  {
    name: "figma_export_asset",
    description: "Export a specific selected layer or descendant to a local file, without changing selection. Use SVG for icons, PNG for rendered/cropped imagery, or imageHash from design context for original image bytes. Never rasterize an entire UI as an implementation substitute.",
    inputSchema:{type:"object",required:["nodeId","outputDirectory"],properties:{
      nodeId:{type:"string"},outputDirectory:{type:"string",description:"Absolute directory in the user's target project for exported assets."},
      format:{type:"string",enum:["PNG","SVG"],default:"PNG"},
      imageHash:{type:"string",description:"Optional hash used by this layer: export original image rather than the rendered layer."},
      maxWidth:{type:"integer",minimum:32,maximum:4096,default:2000}
    },additionalProperties:false}
  },
  {
    name: "figma_connection_status",
    description: "Check whether FigLink is connected to the local Codex companion.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "figma_get_selection",
    description: "Read the current Figma selection as a compact editable node tree.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", default: true },
        maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 6 },
        maxNodes: { type: "integer", minimum: 1, maximum: 1000, default: 300 }
      },
      additionalProperties: false
    }
  },
  {
    name: "figma_get_selection_preview",
    description: "Export PNG previews of up to four selected Figma nodes.",
    inputSchema: {
      type: "object",
      properties: {
        maxNodes: { type: "integer", minimum: 1, maximum: 4, default: 1 },
        maxWidth: { type: "integer", minimum: 256, maximum: 2400, default: 1600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "figma_create_design",
    description: "Create a DesignIR tree in FigLink. Runs immediately with saved Auto-apply consent; otherwise waits for approval in Figma.",
    inputSchema: {
      type: "object",
      required: ["design"],
      properties: {
        design: { type: "object", description: "DesignIR root node with type, name, geometry, style, layout, and children." },
        parentNodeId: { type: "string", description: "Optional selected container node ID. Omit to create on the current page." },
        placement: { type: "string", enum: ["viewport-center", "beside-selection", "preserve"], default: "beside-selection" }
      },
      additionalProperties: false
    }
  },
  {
    name: "figma_patch_selection",
    description: "Apply property operations to selected nodes or descendants. Runs with saved Auto-apply consent or individual approval in FigLink.",
    inputSchema: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            required: ["op"],
            properties: {
              targetNodeId: { type: "string" },
              op: { type: "string", enum: ["set_name", "set_text", "resize", "move", "set_fill", "set_opacity", "set_corner_radius", "set_visibility"] },
              value: {},
              width: { type: "number" },
              height: { type: "number" },
              x: { type: "number" },
              y: { type: "number" }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "figma_export_selection",
    description: "Export selected Figma nodes as PNG or SVG content.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["PNG", "SVG"], default: "PNG" },
        maxNodes: { type: "integer", minimum: 1, maximum: 8, default: 1 },
        maxWidth: { type: "integer", minimum: 256, maximum: 4096, default: 2000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "figma_get_cached_selection",
    description: "Read the last selection snapshot pushed by Figma without another document round trip.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
  };
}

async function callToolLocal(name, args = {}) {
  try {
    switch (name) {
      case "figma_get_design_context":
        return textResult(await requestFigma("get-design-context", args));
      case "figma_export_asset": {
        if (typeof args.outputDirectory !== "string" || !path.isAbsolute(args.outputDirectory)) throw new Error("outputDirectory must be an absolute project directory.");
        const asset = await requestFigma("export-asset", {nodeId:args.nodeId,format:args.format,imageHash:args.imageHash,maxWidth:args.maxWidth});
        const extensions = {PNG:"png",SVG:"svg",JPG:"jpg",GIF:"gif",BIN:"bin"};
        const extension = extensions[asset.format];
        if (!extension || typeof asset.base64 !== "string") throw new Error("Invalid asset response from Figma.");
        const data = Buffer.from(asset.base64,"base64");
        if (data.length > 8 * 1024 * 1024) throw new Error("Asset exceeds the 8 MB limit.");
        const slug = String(asset.name || "asset").replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,64) || "asset";
        await fs.mkdir(args.outputDirectory,{recursive:true});
        const filename = `${slug}-${crypto.randomUUID()}.${extension}`;
        const filePath = path.join(args.outputDirectory,filename);
        await fs.writeFile(filePath,data,{flag:"wx"});
        const {base64, ...metadata} = asset;
        return textResult({...metadata,byteLength:data.length,path:filePath});
      }
      case "figma_connection_status":
        return textResult({
          connected: Boolean(activeFigmaClient?.paired),
          clientName: activeFigmaClient?.clientName || undefined,
          automaticDiscovery: true,
          endpoint: `ws://${HOST}:${PORT}/figma`,
          figmaVersion: activeFigmaClient?.figmaVersion || undefined,
          cachedSelectionAt: latestSelectionAt || undefined
        });

      case "figma_get_selection": {
        const shouldRefresh = args.refresh !== false;
        const result = shouldRefresh
          ? await requestFigma("get-selection", {
              maxDepth: args.maxDepth ?? 6,
              maxNodes: args.maxNodes ?? 300
            })
          : latestSelection;
        if (!result) throw new Error("No cached Figma selection is available.");
        latestSelection = result;
        latestSelectionAt = new Date().toISOString();
        return textResult(result);
      }

      case "figma_get_cached_selection":
        if (!latestSelection) throw new Error("No cached Figma selection is available.");
        return textResult({ ...latestSelection, cachedAt: latestSelectionAt });

      case "figma_get_selection_preview": {
        const result = await requestFigma("get-selection-preview", {
          maxNodes: args.maxNodes ?? 1,
          maxWidth: args.maxWidth ?? 1600
        });
        const images = Array.isArray(result?.images) ? result.images : [];
        if (images.length === 0) throw new Error("Figma did not return a preview. Select an exportable node.");
        return {
          content: images.flatMap((entry) => [
            { type: "text", text: `${entry.name || entry.nodeId} (${entry.width}×${entry.height})` },
            { type: "image", data: entry.base64, mimeType: "image/png" }
          ])
        };
      }

      case "figma_create_design":
        return textResult(await requestFigma("create-design", args));

      case "figma_patch_selection":
        return textResult(await requestFigma("patch-selection", args));

      case "figma_export_selection": {
        const format = args.format || "PNG";
        const result = await requestFigma("export-selection", {
          format,
          maxNodes: args.maxNodes ?? 1,
          maxWidth: args.maxWidth ?? 2000
        });
        const assets = Array.isArray(result?.assets) ? result.assets : [];
        if (format === "PNG") {
          return {
            content: assets.flatMap((entry) => [
              { type: "text", text: `${entry.name || entry.nodeId}.png` },
              { type: "image", data: entry.base64, mimeType: "image/png" }
            ])
          };
        }
        return {
          content: assets.map((entry) => ({
            type: "text",
            text: `<!-- ${entry.name || entry.nodeId}.svg -->\n${Buffer.from(entry.base64, "base64").toString("utf8")}`
          }))
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return errorResult(error);
  }
}

async function callTool(name, args = {}) {
  const mode = await waitForBridgeMode();
  if (mode === "owner") return callToolLocal(name, args);
  if (mode === "proxy") {
    try {
      return await proxyToolCall(name, args);
    } catch (error) {
      return errorResult(new Error(`Shared FigLink bridge is unavailable: ${error.message}`));
    }
  }
  return errorResult(new Error(
    `FigLink could not start its local bridge on ${HOST}:${PORT}. Restart Codex and run the Figma plugin again.`
  ));
}

function writeRpc(message) {
  const body = JSON.stringify(message);
  if (rpcMode === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

async function handleRpc(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.id === undefined) return;

  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "figma-local-bridge", version: SERVER_VERSION }
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        result = await callTool(message.params?.name, message.params?.arguments || {});
        break;
      default:
        writeRpc({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        });
        return;
    }
    writeRpc({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeRpc({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
    });
  }
}

function consumeStdin() {
  while (stdinBuffer.length > 0) {
    const headerEnd = stdinBuffer.indexOf("\r\n\r\n");
    if (stdinBuffer.subarray(0, Math.min(stdinBuffer.length, 15)).toString("ascii").toLowerCase().startsWith("content-length:")) {
      if (headerEnd === -1) return;
      const header = stdinBuffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        stdinBuffer = Buffer.alloc(0);
        return;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (stdinBuffer.length < bodyStart + length) return;
      const body = stdinBuffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      stdinBuffer = stdinBuffer.subarray(bodyStart + length);
      rpcMode = "content-length";
      try {
        void handleRpc(JSON.parse(body));
      } catch (error) {
        stderr(`Invalid MCP JSON: ${error.message}`);
      }
      continue;
    }

    const newline = stdinBuffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = stdinBuffer.subarray(0, newline).toString("utf8").trim();
    stdinBuffer = stdinBuffer.subarray(newline + 1);
    if (!line) continue;
    rpcMode = "line";
    try {
      void handleRpc(JSON.parse(line));
    } catch (error) {
      stderr(`Invalid MCP JSON: ${error.message}`);
    }
  }
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  consumeStdin();
});

process.stdin.on("end", () => {
  for (const [, pending] of pendingFigmaRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Codex disconnected."));
  }
  httpServer.close();
});

process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
