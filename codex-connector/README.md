# FigLink Connector

This folder is the background Codex companion for the independent **FigLink** plugin. It is infrastructure, not the primary Figma product.

When Codex starts a task with this companion enabled, it discovers or starts one shared private bridge on the local Mac. Launching FigLink in Figma finds that bridge automatically. Multiple Codex chats reuse the same Figma connection; users never need to enter or synchronize port numbers.

The connector provides tools to:

- read the active Figma selection;
- receive PNG previews;
- export PNG or SVG;
- create DesignIR node trees;
- patch selected nodes with individual approval or saved Auto-apply consent inside FigLink.

It has no npm dependencies and does not listen on a public network interface.

The primary Figma package is delivered separately in `outputs/FigLink`.
