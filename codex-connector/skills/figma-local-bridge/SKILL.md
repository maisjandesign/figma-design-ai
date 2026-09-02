---
name: figma-design-ai
description: Read the active Figma selection and create or patch Figma nodes through the independent FIGMA-DESIGN-AI plugin. Use when the user mentions FIGMA-DESIGN-AI, selected Figma layers, sending a design to Figma, or reading design back from Figma.
---

# FIGMA-DESIGN-AI

Use the `figma-local-bridge` MCP tools for all interaction with the open Figma development plugin.

## Connection

1. Call `figma_connection_status` before the first Figma operation in a turn.
2. If disconnected, tell the user to run **FIGMA-DESIGN-AI** inside Figma. It discovers the local Codex companion automatically.
3. Do not ask for a pairing code during the normal FIGMA-DESIGN-AI flow.

## Reading Figma

1. Call `figma_get_selection` for the structured node tree.
2. For visual analysis or implementation, also call `figma_get_selection_preview`.
3. Handle zero, one, and multiple selected nodes explicitly.
4. Treat `truncated: true` as an instruction to request a smaller scope or lower tree depth.
5. Never infer hidden document content that was not returned by the bridge.

## Writing Figma

- Use `figma_create_design` for new node trees.
- Use `figma_patch_selection` for targeted changes to the current selection or descendants.
- The Figma UI asks the user to approve every write. Tell the user briefly what approval to expect before calling a write tool.
- Do not target nodes outside the active selection when patching.
- Prefer creating a new frame beside the selection for exploratory alternatives.
- Prefer small patch batches with clear intent over a large destructive rewrite.
- After a write, call `figma_get_selection` to verify the resulting structure and `figma_get_selection_preview` when appearance matters.

## DesignIR conventions

Supported node types are `FRAME`, `COMPONENT`, `TEXT`, `RECTANGLE`, `ELLIPSE`, and `LINE`.

Use hex colors such as `#2563EB` or normalized RGB objects. Common fields include:

- Geometry: `x`, `y`, `width`, `height`, `rotation`
- Appearance: `fill`, `stroke`, `strokeWeight`, `opacity`, `cornerRadius`
- Layout: `layoutMode`, `itemSpacing`, `padding`, directional padding, axis alignment and sizing
- Text: `characters`, `fontFamily`, `fontStyle`, `fontSize`, `lineHeight`, `letterSpacing`, alignment
- Hierarchy: `children`

Use `parentNodeId` only when it is a selected container or a descendant of a selected node. Omit it to create on the current page.

## Safety

- Do not ask the user to disable pairing or expand the network allowlist.
- Do not place arbitrary JavaScript in DesignIR.
- Preserve the current selection unless the user asks to replace or modify it.
- If a font is unavailable, the Figma plugin falls back to Inter Regular; mention this only when it affects fidelity.
