figma.showUI(__html__, { width: 380, height: 600, themeColors: true });

const BRIDGE_DATA_KEY = "figmaLocalBridgeId";
let selectionTimer = null;
let documentRevision = 0;
const contextPages = new Map();

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function plainValue(value) {
  if (value === figma.mixed || typeof value === "symbol" || typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(plainValue).filter((item) => item !== undefined);
  const result = {};
  for (const key of Object.keys(value)) {
    const next = plainValue(value[key]);
    if (next !== undefined) result[key] = next;
  }
  return result;
}

function readProperty(node, key) {
  if (!(key in node)) return undefined;
  try {
    return plainValue(node[key]);
  } catch {
    return undefined;
  }
}

function serializeNode(node, depth, state) {
  if (state.count >= state.maxNodes) {
    state.truncated = true;
    return null;
  }
  state.count += 1;

  const result = {
    id: node.id,
    type: node.type,
    name: node.name
  };

  const bridgeId = typeof node.getPluginData === "function" ? node.getPluginData(BRIDGE_DATA_KEY) : "";
  if (bridgeId) result.bridgeId = bridgeId;

  const commonProperties = [
    "visible", "locked", "opacity", "blendMode", "x", "y", "width", "height", "rotation",
    "minWidth", "maxWidth", "minHeight", "maxHeight", "layoutAlign", "layoutGrow",
    "layoutPositioning", "constraints", "fills", "strokes", "strokeWeight", "strokeAlign",
    "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius",
    "bottomLeftRadius", "clipsContent", "layoutMode", "itemSpacing", "counterAxisSpacing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems",
    "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode", "layoutWrap",
    "textAutoResize", "textAlignHorizontal", "textAlignVertical", "fontName", "fontSize",
    "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing", "textCase",
    "textDecoration", "characters", "componentProperties", "boundVariables",
    "relativeTransform", "absoluteTransform", "absoluteRenderBounds", "layoutSizingHorizontal",
    "layoutSizingVertical", "isMask", "maskType", "strokeTopWeight", "strokeBottomWeight",
    "strokeLeftWeight", "strokeRightWeight", "textStyleId", "fillStyleId", "strokeStyleId",
    "effectStyleId", "exportSettings"
  ];

  for (const key of commonProperties) {
    const value = readProperty(node, key);
    if (value !== undefined) result[key] = value;
  }

  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    result.absoluteBoundingBox = plainValue(node.absoluteBoundingBox);
  }

  if (state.includeTextRuns && node.type === "TEXT") {
    try {
      result.textRuns = plainValue(node.getStyledTextSegments([
        "fontName", "fontSize", "fontWeight", "fills", "lineHeight", "letterSpacing",
        "textDecoration", "textCase", "textStyleId", "hyperlink"
      ]));
    } catch (error) { result.textRunsError = String(error); }
  }

  if (depth < state.maxDepth && "children" in node) {
    result.children = [];
    for (const child of node.children) {
      const serialized = serializeNode(child, depth + 1, state);
      if (serialized) result.children.push(serialized);
      if (state.count >= state.maxNodes) {
        if (result.children.length < node.children.length) state.truncated = true;
        break;
      }
    }
    if (result.children.length < node.children.length) result.childCount = node.children.length;
  } else if ("children" in node && node.children.length > 0) {
    result.childCount = node.children.length;
    state.truncated = true;
  }

  return result;
}

function serializeSelection(options) {
  const state = {
    count: 0,
    maxNodes: clamp(Math.round(finiteNumber(options?.maxNodes, 300)), 1, 1000),
    maxDepth: clamp(Math.round(finiteNumber(options?.maxDepth, 6)), 0, 12),
    truncated: false
  };
  const nodes = [];
  for (const node of figma.currentPage.selection) {
    const serialized = serializeNode(node, 0, state);
    if (serialized) nodes.push(serialized);
    if (state.count >= state.maxNodes) {
      if (nodes.length < figma.currentPage.selection.length) state.truncated = true;
      break;
    }
  }
  return {
    editorType: figma.editorType,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selectionCount: figma.currentPage.selection.length,
    serializedNodeCount: state.count,
    truncated: state.truncated,
    nodes
  };
}

function selectionSignature() {
  return JSON.stringify([figma.currentPage.id, figma.currentPage.selection.map(n => n.id)]);
}

async function scopedNode(id) {
  if (typeof id !== "string") throw new Error("A nodeId is required.");
  const node = await figma.getNodeByIdAsync(id);
  const roots = new Set(figma.currentPage.selection.map(n => n.id));
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (roots.has(ancestor.id)) return node;
  }
  throw new Error(`Node ${id} is not inside the current selection.`);
}

// Flat, resumable preorder traversal. No depth limit; parentId preserves hierarchy.
async function getDesignContext(options = {}) {
  const now = Date.now();
  for (const [key, value] of contextPages) if (now - value.at > 300000) contextPages.delete(key);
  let session;
  if (options.cursor) {
    session = contextPages.get(options.cursor);
    if (!session) throw new Error("Context cursor expired or was already consumed. Restart the read.");
    if (session.signature !== selectionSignature() || session.revision !== documentRevision) {
      contextPages.delete(options.cursor);
      throw new Error("Selection or document changed. Restart the context read for a consistent result.");
    }
  } else {
    if (!figma.currentPage.selection.length) throw new Error("Select a frame or layers first.");
    const roots = options.nodeId ? [await scopedNode(options.nodeId)] : figma.currentPage.selection;
    session = { signature: selectionSignature(), revision: documentRevision, at: now,
      roots: roots.map(n => n.id), stack: roots.slice().reverse().map(n => ({node:n,depth:0})),
      seen: new Set(), count:0 };
    if (contextPages.size >= 16) contextPages.delete(contextPages.keys().next().value);
  }
  const pageSize = clamp(Math.round(finiteNumber(options.pageSize, 75)), 1, 150);
  const nodes = [];
  const assets = [];
  while (session.stack.length && nodes.length < pageSize) {
    const {node, depth} = session.stack.pop();
    if (session.seen.has(node.id)) continue;
    session.seen.add(node.id);
    const item = serializeNode(node, 0, {count:0,maxNodes:1,maxDepth:0,includeTextRuns:true,truncated:false});
    item.parentId = node.parent?.id || null;
    item.depth = depth;
    item.childCount = "children" in node ? node.children.length : 0;
    item.siblingIndex = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : 0;
    nodes.push(item);
    for (const property of ["fills", "strokes"]) {
      const paints = item[property];
      if (Array.isArray(paints)) paints.forEach((paint, index) => {
        if (paint.type === "IMAGE" && paint.imageHash) assets.push({nodeId:node.id,name:node.name,
          kind:"image",property,index,imageHash:paint.imageHash,visible:paint.visible !== false,
          scaleMode:paint.scaleMode,imageTransform:paint.imageTransform});
      });
    }
    if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE"].includes(node.type)) {
      assets.push({nodeId:node.id,name:node.name,kind:"vector",suggestedFormat:"SVG"});
    }
    if ("children" in node) for (let i=node.children.length-1;i>=0;i--) session.stack.push({node:node.children[i],depth:depth+1});
  }
  session.count += nodes.length;
  session.at = now;
  if (options.cursor) contextPages.delete(options.cursor);
  const nextCursor = session.stack.length ? `${now}-${Math.random().toString(36).slice(2)}` : null;
  if (nextCursor) contextPages.set(nextCursor, session);
  return {page:{id:figma.currentPage.id,name:figma.currentPage.name},rootNodeIds:session.roots,
    revision:session.revision,nodes,assets,readNodeCount:session.count,complete:!nextCursor,nextCursor,
    guidance:"Read every page until complete=true. Build UI from layer geometry, layout and textRuns. Export required asset nodes separately; previews are visual references only."};
}

async function exportAsset(options = {}) {
  const node = await scopedNode(options.nodeId);
  let bytes;
  let format = String(options.format || "PNG").toUpperCase();
  let source;
  if (options.imageHash) {
    const paints = [readProperty(node,"fills"),readProperty(node,"strokes")].flat().filter(Boolean);
    if (!paints.some(p => p.type === "IMAGE" && p.imageHash === options.imageHash)) throw new Error("Image hash is not used by this layer.");
    const image = figma.getImageByHash(options.imageHash);
    if (!image) throw new Error("Image is not available in Figma.");
    bytes = await image.getBytesAsync();
    format = bytes[0] === 137 && bytes[1] === 80 ? "PNG" : bytes[0] === 255 && bytes[1] === 216 ? "JPG" : bytes[0] === 71 && bytes[1] === 73 ? "GIF" : "BIN";
    source = "original-image";
  } else {
    if (!["PNG","SVG"].includes(format)) throw new Error("Use PNG or SVG.");
    const maxWidth = clamp(finiteNumber(options.maxWidth, 2000), 32, 4096);
    bytes = await node.exportAsync(format === "SVG" ? {format:"SVG"} : {format:"PNG",constraint:{type:"SCALE",value:Math.min(1,maxWidth/Math.max(1,node.width))}});
    source = "rendered-layer";
  }
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Asset exceeds 8 MB. Export the rendered layer as a smaller PNG instead.");
  return {nodeId:node.id,name:node.name,format,source,imageHash:options.imageHash || null,
    byteLength:bytes.length,base64:bytesToBase64(bytes)};
}

function bytesToBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    output += alphabet[(combined >> 18) & 63];
    output += alphabet[(combined >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(combined >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[combined & 63] : "=";
  }
  return output;
}

async function exportNodes(options, previewOnly) {
  const maxNodes = clamp(Math.round(finiteNumber(options?.maxNodes, 1)), 1, previewOnly ? 4 : 8);
  const maxWidth = clamp(Math.round(finiteNumber(options?.maxWidth, previewOnly ? 1600 : 2000)), 256, 4096);
  const format = previewOnly ? "PNG" : String(options?.format || "PNG").toUpperCase();
  if (format !== "PNG" && format !== "SVG") throw new Error("Only PNG and SVG exports are supported.");

  const selected = figma.currentPage.selection.slice(0, maxNodes);
  if (selected.length === 0) throw new Error("Select at least one Figma node first.");

  const output = [];
  for (const node of selected) {
    if (typeof node.exportAsync !== "function") continue;
    const scale = node.width > maxWidth ? maxWidth / node.width : 1;
    const settings = format === "PNG"
      ? { format: "PNG", constraint: { type: "SCALE", value: Math.max(0.05, scale) } }
      : { format: "SVG" };
    const bytes = await node.exportAsync(settings);
    output.push({
      nodeId: node.id,
      name: node.name,
      width: Math.round(node.width * scale),
      height: Math.round(node.height * scale),
      base64: bytesToBase64(bytes)
    });
  }
  return previewOnly ? { images: output } : { format, assets: output };
}

function parseColor(value) {
  if (typeof value === "object" && value && typeof value.r === "number") {
    return {
      color: {
        r: clamp(value.r, 0, 1),
        g: clamp(value.g, 0, 1),
        b: clamp(value.b, 0, 1)
      },
      opacity: value.a === undefined ? 1 : clamp(value.a, 0, 1)
    };
  }

  const input = String(value || "#000000").trim().replace(/^#/, "");
  let hex = input;
  if (hex.length === 3 || hex.length === 4) {
    hex = hex.split("").map((character) => character + character).join("");
  }
  if (hex.length !== 6 && hex.length !== 8) throw new Error(`Invalid color: ${value}`);
  const numeric = Number.parseInt(hex, 16);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid color: ${value}`);
  const hasAlpha = hex.length === 8;
  return {
    color: {
      r: ((numeric >> (hasAlpha ? 24 : 16)) & 255) / 255,
      g: ((numeric >> (hasAlpha ? 16 : 8)) & 255) / 255,
      b: ((numeric >> (hasAlpha ? 8 : 0)) & 255) / 255
    },
    opacity: hasAlpha ? (numeric & 255) / 255 : 1
  };
}

function solidPaint(value) {
  const parsed = parseColor(value);
  return [{ type: "SOLID", color: parsed.color, opacity: parsed.opacity }];
}

function makeBridgeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeNodeType(value) {
  return String(value || "FRAME").trim().toUpperCase().replace(/[- ]/g, "_");
}

function applyGeometry(node, spec) {
  if ("resize" in node) {
    const width = clamp(finiteNumber(spec.width, node.width), 0.01, 100000);
    const height = clamp(finiteNumber(spec.height, node.height), 0.01, 100000);
    node.resize(width, height);
  }
  if (typeof spec.x === "number") node.x = spec.x;
  if (typeof spec.y === "number") node.y = spec.y;
  if (typeof spec.rotation === "number" && "rotation" in node) node.rotation = spec.rotation;
}

function applyCommonStyle(node, spec) {
  if (typeof spec.name === "string" && spec.name.trim()) node.name = spec.name.trim();
  if (typeof spec.visible === "boolean") node.visible = spec.visible;
  if (typeof spec.opacity === "number" && "opacity" in node) node.opacity = clamp(spec.opacity, 0, 1);
  if (spec.fill !== undefined && "fills" in node) node.fills = spec.fill === null ? [] : solidPaint(spec.fill);
  if (spec.stroke !== undefined && "strokes" in node) node.strokes = spec.stroke === null ? [] : solidPaint(spec.stroke);
  if (typeof spec.strokeWeight === "number" && "strokeWeight" in node) node.strokeWeight = Math.max(0, spec.strokeWeight);
  if (typeof spec.cornerRadius === "number" && "cornerRadius" in node) {
    node.cornerRadius = Math.max(0, spec.cornerRadius);
  }
  if (spec.constraints && "constraints" in node) {
    node.constraints = {
      horizontal: spec.constraints.horizontal || "MIN",
      vertical: spec.constraints.vertical || "MIN"
    };
  }
  if (spec.layoutAlign && "layoutAlign" in node) node.layoutAlign = spec.layoutAlign;
  if (typeof spec.layoutGrow === "number" && "layoutGrow" in node) node.layoutGrow = spec.layoutGrow;
}

function applyFrameLayout(node, spec) {
  if (!("layoutMode" in node)) return;
  if (spec.layoutMode) node.layoutMode = String(spec.layoutMode).toUpperCase();
  if (typeof spec.itemSpacing === "number") node.itemSpacing = spec.itemSpacing;
  if (typeof spec.padding === "number") {
    node.paddingTop = spec.padding;
    node.paddingRight = spec.padding;
    node.paddingBottom = spec.padding;
    node.paddingLeft = spec.padding;
  }
  if (typeof spec.paddingTop === "number") node.paddingTop = spec.paddingTop;
  if (typeof spec.paddingRight === "number") node.paddingRight = spec.paddingRight;
  if (typeof spec.paddingBottom === "number") node.paddingBottom = spec.paddingBottom;
  if (typeof spec.paddingLeft === "number") node.paddingLeft = spec.paddingLeft;
  if (spec.primaryAxisAlignItems) node.primaryAxisAlignItems = spec.primaryAxisAlignItems;
  if (spec.counterAxisAlignItems) node.counterAxisAlignItems = spec.counterAxisAlignItems;
  if (spec.primaryAxisSizingMode) node.primaryAxisSizingMode = spec.primaryAxisSizingMode;
  if (spec.counterAxisSizingMode) node.counterAxisSizingMode = spec.counterAxisSizingMode;
  if (typeof spec.clipsContent === "boolean") node.clipsContent = spec.clipsContent;
}

async function setTextProperties(node, spec) {
  const requestedFont = spec.fontName && typeof spec.fontName === "object"
    ? { family: spec.fontName.family, style: spec.fontName.style || "Regular" }
    : { family: typeof spec.fontFamily === "string" ? spec.fontFamily : "Inter", style: spec.fontStyle || "Regular" };
  try {
    await figma.loadFontAsync(requestedFont);
    node.fontName = requestedFont;
  } catch {
    const fallback = { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(fallback);
    node.fontName = fallback;
  }
  node.characters = String(spec.characters ?? spec.text ?? "Text");
  if (typeof spec.fontSize === "number") node.fontSize = Math.max(1, spec.fontSize);
  if (spec.textAlignHorizontal) node.textAlignHorizontal = spec.textAlignHorizontal;
  if (spec.textAlignVertical) node.textAlignVertical = spec.textAlignVertical;
  if (spec.textAutoResize) node.textAutoResize = spec.textAutoResize;
  if (typeof spec.lineHeight === "number") node.lineHeight = { unit: "PIXELS", value: spec.lineHeight };
  if (typeof spec.letterSpacing === "number") node.letterSpacing = { unit: "PIXELS", value: spec.letterSpacing };
}

async function createNodeFromSpec(spec, parent) {
  if (!spec || typeof spec !== "object") throw new Error("Every DesignIR node must be an object.");
  const type = normalizeNodeType(spec.type);
  let node;
  switch (type) {
    case "FRAME": node = figma.createFrame(); break;
    case "TEXT": node = figma.createText(); break;
    case "RECTANGLE": node = figma.createRectangle(); break;
    case "ELLIPSE": node = figma.createEllipse(); break;
    case "LINE": node = figma.createLine(); break;
    case "COMPONENT": node = figma.createComponent(); break;
    default: throw new Error(`Unsupported DesignIR node type: ${type}`);
  }

  if (parent) parent.appendChild(node);
  if (typeof node.setPluginData === "function") node.setPluginData(BRIDGE_DATA_KEY, spec.bridgeId || makeBridgeId());
  applyGeometry(node, spec);
  applyCommonStyle(node, spec);
  if (type === "FRAME" || type === "COMPONENT") applyFrameLayout(node, spec);
  if (type === "TEXT") await setTextProperties(node, spec);

  if (Array.isArray(spec.children)) {
    if (!("appendChild" in node)) throw new Error(`${type} cannot contain child nodes.`);
    for (const child of spec.children) await createNodeFromSpec(child, node);
  }
  return node;
}

function selectionScope() {
  const scope = new Map();
  function visit(node) {
    scope.set(node.id, node);
    if ("children" in node) for (const child of node.children) visit(child);
  }
  for (const node of figma.currentPage.selection) visit(node);
  return scope;
}

function resolveParent(parentNodeId) {
  if (!parentNodeId) return null;
  const scope = selectionScope();
  const parent = scope.get(parentNodeId);
  if (!parent) throw new Error("parentNodeId must refer to a selected node or its descendant.");
  if (!("appendChild" in parent)) throw new Error("The requested parent cannot contain children.");
  return parent;
}

async function createDesign(params) {
  const design = params?.design;
  if (!design || typeof design !== "object") throw new Error("A DesignIR root object is required.");
  const parent = resolveParent(params.parentNodeId);
  const root = await createNodeFromSpec(design, parent);

  if (!parent && params.placement !== "preserve") {
    if (params.placement === "beside-selection" && figma.currentPage.selection.length > 0) {
      const selection = figma.currentPage.selection;
      const rightEdge = Math.max(...selection.map((node) => node.x + node.width));
      const top = Math.min(...selection.map((node) => node.y));
      root.x = rightEdge + 96;
      root.y = top;
    } else {
      root.x = figma.viewport.center.x - root.width / 2;
      root.y = figma.viewport.center.y - root.height / 2;
    }
  }

  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  figma.commitUndo();
  return {
    created: serializeNode(root, 0, { count: 0, maxNodes: 300, maxDepth: 6, truncated: false })
  };
}

async function applyOperation(node, operation) {
  switch (operation.op) {
    case "set_name":
      node.name = String(operation.value || "Untitled");
      break;
    case "set_text":
      if (node.type !== "TEXT") throw new Error(`${node.id} is not a text node.`);
      await figma.loadFontAsync(node.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : node.fontName);
      node.characters = String(operation.value ?? "");
      break;
    case "resize":
      if (!("resize" in node)) throw new Error(`${node.id} cannot be resized.`);
      node.resize(
        clamp(finiteNumber(operation.width, node.width), 0.01, 100000),
        clamp(finiteNumber(operation.height, node.height), 0.01, 100000)
      );
      break;
    case "move":
      if (!("x" in node)) throw new Error(`${node.id} cannot be moved.`);
      node.x = finiteNumber(operation.x, node.x);
      node.y = finiteNumber(operation.y, node.y);
      break;
    case "set_fill":
      if (!("fills" in node)) throw new Error(`${node.id} does not support fills.`);
      node.fills = operation.value === null ? [] : solidPaint(operation.value);
      break;
    case "set_opacity":
      if (!("opacity" in node)) throw new Error(`${node.id} does not support opacity.`);
      node.opacity = clamp(finiteNumber(operation.value, node.opacity), 0, 1);
      break;
    case "set_corner_radius":
      if (!("cornerRadius" in node)) throw new Error(`${node.id} does not support corner radius.`);
      node.cornerRadius = Math.max(0, finiteNumber(operation.value, 0));
      break;
    case "set_visibility":
      node.visible = Boolean(operation.value);
      break;
    default:
      throw new Error(`Unsupported patch operation: ${operation.op}`);
  }
}

async function patchSelection(params) {
  const operations = params?.operations;
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("At least one operation is required.");
  if (figma.currentPage.selection.length === 0) throw new Error("Select a node before applying patches.");
  const scope = selectionScope();
  const singleSelected = figma.currentPage.selection.length === 1 ? figma.currentPage.selection[0] : null;
  const changed = new Set();

  for (const operation of operations) {
    const node = operation.targetNodeId ? scope.get(operation.targetNodeId) : singleSelected;
    if (!node) throw new Error("Each operation needs a targetNodeId when multiple nodes are selected.");
    await applyOperation(node, operation);
    if (typeof node.setPluginData === "function" && !node.getPluginData(BRIDGE_DATA_KEY)) {
      node.setPluginData(BRIDGE_DATA_KEY, makeBridgeId());
    }
    changed.add(node.id);
  }
  figma.commitUndo();
  return { changedNodeIds: Array.from(changed), operationCount: operations.length };
}

async function handleBridgeCommand(message) {
  switch (message.command) {
    case "get-design-context": return getDesignContext(message.params);
    case "export-asset": return exportAsset(message.params);
    case "get-selection": return serializeSelection(message.params);
    case "get-selection-preview": return exportNodes(message.params, true);
    case "export-selection": return exportNodes(message.params, false);
    case "create-design": return createDesign(message.params);
    case "patch-selection": return patchSelection(message.params);
    default: throw new Error(`Unknown bridge command: ${message.command}`);
  }
}

async function respondToBridge(message) {
  try {
    const result = await handleBridgeCommand(message);
    figma.ui.postMessage({ type: "bridge-response", requestId: message.requestId, ok: true, result });
    scheduleSelectionUpdate();
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-response",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function scheduleSelectionUpdate() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    figma.ui.postMessage({ type: "selection-snapshot", payload: serializeSelection({ maxDepth: 4, maxNodes: 150 }) });
  }, 120);
}

figma.on("selectionchange", scheduleSelectionUpdate);
figma.on("documentchange", () => { documentRevision += 1; });

figma.ui.onmessage = async (message) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "request-selection") {
    figma.ui.postMessage({ type: "selection-snapshot", payload: serializeSelection({ maxDepth: 4, maxNodes: 150 }) });
    return;
  }
  if (message.type === "bridge-command") {
    await respondToBridge(message);
  }
};

(async () => {
  figma.ui.postMessage({
    type: "plugin-ready",
    figmaVersion: figma.apiVersion
  });
  scheduleSelectionUpdate();
})();
