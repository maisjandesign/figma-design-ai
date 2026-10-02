---
name: figma-design-ai
description: FigLink (formerly FIGMA-DESIGN-AI). Read the active Figma selection and create or patch Figma nodes through the independent FIGMA-DESIGN-AI plugin. Use when the user mentions FIGMA-DESIGN-AI, selected Figma layers, sending a design to Figma, or reading design back from Figma.
---

# FigLink

Use the `figma-local-bridge` MCP tools for all interaction with the open Figma development plugin.

## Connection

1. Call `figma_connection_status` before the first Figma operation in a turn.
2. If disconnected, tell the user to run **FIGMA-DESIGN-AI** inside Figma. It discovers the local Codex companion automatically.
3. Do not ask for a pairing code during the normal FIGMA-DESIGN-AI flow.

## Reading Figma

1. Before implementing or analyzing a whole frame, call `figma_get_design_context`. It returns flat layer records with parentId, siblingIndex, geometry, Auto Layout, fills, mixed-style textRuns, and asset references.
2. Repeat `figma_get_design_context` with each `nextCursor` until `complete: true`. Collect nodes by ID and rebuild hierarchy using parentId / siblingIndex. Never treat a partial page, compact selection or preview as the complete design. If the document/selection changes or a cursor expires, restart the read. Report readNodeCount and completeness briefly before implementation.
3. Call `figma_get_selection_preview` as a visual reference, not as a replacement for layer data. Handle zero, one and multiple selected roots explicitly.
4. Use returned dimensions, parent-relative coordinates, transforms, layoutSizing, padding, spacing, alignment, constraints and textRuns to implement actual layout and text. Do not guess spacing, fonts or hidden content from the screenshot when layer values are available. Surface textRunsError or other missing information instead of claiming full fidelity.
5. Inspect asset references on every page. Use `figma_export_asset` with a nodeId and an absolute outputDirectory inside the target project to save needed photos and icons. Use imageHash for original image bytes; preserve the layer's scaleMode, imageTransform and crop. Use PNG for the visible rendered crop, SVG for an icon/vector or its containing group. Export a whole icon group when individual paths belong together. Keep a nodeId/imageHash-to-file-path mapping and reuse duplicates. Do not substitute invented images, emoji or whole-frame screenshots for source assets.
6. Build containers as layout and text as text. Rasterize a UI container only when the user explicitly requests a flat image. Compare the implementation against the preview after building it.
7. `figma_get_selection` and `figma_get_cached_selection` are compact navigation snapshots only. If truncated, use paginated design context; lowering depth loses information and is not a solution for implementation.
8. If the new tools are missing or return an unknown-command error, ask the user to restart the updated Figma plugin and Codex, then start a new task. Do not silently fall back to screenshot-only implementation.

## Writing Figma

- Use `figma_create_design` for new node trees.
- Use `figma_patch_selection` for targeted changes to the current selection or descendants.
- FigLink supports manual approval and a remembered Auto-apply choice. With Auto-apply enabled, writes run immediately; otherwise the plugin expands for approval. Do not promise an approval dialog for every write. Never change this preference on the user's behalf unless they explicitly request it.
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
