#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serverUrl = new URL("../mcp-server/index.mjs", import.meta.url);
const testPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const childEnv = { ...process.env, FIGMA_LOCAL_BRIDGE_PORT: String(testPort) };
const child = spawn(process.execPath, [serverUrl.pathname], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
let proxyChild = null;
let outputBuffer = "";
let nextId = 1;
const pending = new Map();
const wsQueue = [];
const wsWaiters = [];
let stderrBuffer = "";
let resolveServerReady;
let rejectServerReady;
const serverReady = new Promise((resolve, reject) => {
  resolveServerReady = resolve;
  rejectServerReady = reject;
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString("utf8");
  if (stderrBuffer.includes("Listening on")) resolveServerReady();
  if (stderrBuffer.includes("already in use") || stderrBuffer.includes("Bridge server error")) {
    rejectServerReady(new Error(stderrBuffer.trim()));
  }
});

function call(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout calling ${method}`)), 5000);
    pending.set(id, { resolve, reject, timer });
  });
}

function receiveWs(message) {
  const index = wsWaiters.findIndex((waiter) => waiter.predicate(message));
  if (index !== -1) {
    const [waiter] = wsWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  } else {
    wsQueue.push(message);
  }
}

function nextWs(predicate, label) {
  const index = wsQueue.findIndex(predicate);
  if (index !== -1) return Promise.resolve(wsQueue.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for WebSocket ${label}`)), 5000);
    wsWaiters.push({ predicate, resolve, timer });
  });
}

child.stdout.on("data", (chunk) => {
  outputBuffer += chunk.toString("utf8");
  let newline;
  while ((newline = outputBuffer.indexOf("\n")) !== -1) {
    const line = outputBuffer.slice(0, newline).trim();
    outputBuffer = outputBuffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiting = pending.get(message.id);
    if (!waiting) continue;
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  }
});

try {
  await Promise.race([
    serverReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Bridge did not start: ${stderrBuffer}`)), 5000))
  ]);
  const initialized = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "1" } });
  assert.equal(initialized.serverInfo.name, "figma-local-bridge");

  const list = await call("tools/list");
  assert.equal(list.tools.length, 9);
  assert.ok(list.tools.some((tool) => tool.name === "figma_get_selection"));
  assert.ok(list.tools.some((tool) => tool.name === "figma_create_design"));

  const status = await call("tools/call", { name: "figma_connection_status", arguments: {} });
  assert.equal(status.structuredContent.connected, false);
  assert.equal(status.structuredContent.automaticDiscovery, true);

  proxyChild = spawn(process.execPath, [serverUrl.pathname], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  let proxyOutputBuffer = "";
  let proxyStderrBuffer = "";
  let proxyNextId = 1;
  const proxyPending = new Map();
  let resolveProxyReady;
  let rejectProxyReady;
  const proxyReady = new Promise((resolve, reject) => {
    resolveProxyReady = resolve;
    rejectProxyReady = reject;
  });
  proxyChild.stderr.on("data", (chunk) => {
    proxyStderrBuffer += chunk.toString("utf8");
    if (proxyStderrBuffer.includes("Using the existing shared bridge")) resolveProxyReady();
    if (proxyStderrBuffer.includes("incompatible process")) rejectProxyReady(new Error(proxyStderrBuffer.trim()));
  });
  proxyChild.stdout.on("data", (chunk) => {
    proxyOutputBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = proxyOutputBuffer.indexOf("\n")) !== -1) {
      const line = proxyOutputBuffer.slice(0, newline).trim();
      proxyOutputBuffer = proxyOutputBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiting = proxyPending.get(message.id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      proxyPending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    }
  });
  function callProxy(method, params = {}) {
    const id = proxyNextId++;
    proxyChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout calling proxy ${method}`)), 5000);
      proxyPending.set(id, { resolve, reject, timer });
    });
  }
  await Promise.race([
    proxyReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Proxy did not start: ${proxyStderrBuffer}`)), 5000))
  ]);
  const proxyInitialized = await callProxy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "proxy-smoke-test", version: "1" } });
  assert.equal(proxyInitialized.serverInfo.name, "figma-local-bridge");

  const socket = new WebSocket(`ws://127.0.0.1:${testPort}/figma`);
  socket.onmessage = (event) => receiveWs(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Unable to open mock Figma WebSocket"));
  });
  socket.send(JSON.stringify({
    type: "hello",
    clientKey: "figma-design-ai-local-v1",
    clientName: "FIGMA-DESIGN-AI",
    figmaVersion: "smoke-test"
  }));
  await nextWs((message) => message.type === "hello-ack", "pairing acknowledgement");
  const proxyStatus = await callProxy("tools/call", { name: "figma_connection_status", arguments: {} });
  assert.equal(proxyStatus.structuredContent.connected, true);

  const selectionCall = callProxy("tools/call", {
    name: "figma_get_selection",
    arguments: { refresh: true, maxDepth: 2, maxNodes: 20 }
  });
  const selectionCommand = await nextWs((message) => message.command === "get-selection", "selection command");
  socket.send(JSON.stringify({
    type: "response",
    requestId: selectionCommand.requestId,
    ok: true,
    result: {
      selectionCount: 1,
      serializedNodeCount: 1,
      truncated: false,
      nodes: [{ id: "1:2", type: "FRAME", name: "Smoke Frame", width: 320, height: 200 }]
    }
  }));
  const selection = await selectionCall;
  assert.equal(selection.structuredContent.nodes[0].name, "Smoke Frame");

  const contextCall = callProxy("tools/call", {name:"figma_get_design_context",arguments:{pageSize:50}});
  const contextCommand = await nextWs(m=>m.command === "get-design-context", "context command");
  assert.equal(contextCommand.params.pageSize,50);
  socket.send(JSON.stringify({type:"response",requestId:contextCommand.requestId,ok:true,
    result:{nodes:[{id:"1:3",parentId:"1:2",type:"VECTOR"}],complete:true,nextCursor:null,readNodeCount:1}}));
  assert.equal((await contextCall).structuredContent.complete,true);
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(),"figma-assets-test-"));
  const assetCall = callProxy("tools/call", {name:"figma_export_asset",arguments:{nodeId:"1:3",format:"SVG",outputDirectory}});
  const assetCommand = await nextWs(m=>m.command === "export-asset", "asset command");
  assert.equal(assetCommand.params.nodeId,"1:3");
  socket.send(JSON.stringify({type:"response",requestId:assetCommand.requestId,ok:true,
    result:{nodeId:"1:3",name:"Icon",format:"SVG",source:"rendered-layer",base64:Buffer.from('<svg/>').toString('base64')}}));
  const asset = (await assetCall).structuredContent;
  assert.equal(await fs.readFile(asset.path,"utf8"),'<svg/>');
  assert.equal(asset.base64,undefined,'Asset bytes must not flood model context');
  await fs.unlink(asset.path);
  await fs.rmdir(outputDirectory);

  const createCall = callProxy("tools/call", {
    name: "figma_create_design",
    arguments: { design: { type: "FRAME", name: "Created Frame", width: 240, height: 120 } }
  });
  const createCommand = await nextWs((message) => message.command === "create-design", "create command");
  socket.send(JSON.stringify({
    type: "response",
    requestId: createCommand.requestId,
    ok: true,
    result: { created: { id: "2:3", type: "FRAME", name: "Created Frame" } }
  }));
  const created = await createCall;
  assert.equal(created.structuredContent.created.name, "Created Frame");
  socket.close();

  process.stdout.write("Smoke test passed: shared bridge, selection/context reads, asset file export and approved write round trip.\n");
} finally {
  if (proxyChild) proxyChild.kill("SIGTERM");
  child.kill("SIGTERM");
}
