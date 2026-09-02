# Setup

## Requirements

- macOS
- Figma desktop app
- Codex desktop app
- Node.js available to the Codex host

## Figma

1. Open a Figma Design file in the desktop app.
2. Choose **Plugins → Development → Import plugin from manifest…**.
3. Select the repository's `manifest.json`.
4. Run **Plugins → Development → FIGMA DESIGN AI**.

The panel should move from **Connecting** to **Connected** after the Codex companion starts.

## Codex companion

The `codex-connector` directory contains the reusable skill, MCP server, shared loopback bridge, and two-process smoke test. Install it through a local Codex marketplace and start a new chat after every connector update.

## First test

1. Keep FIGMA DESIGN AI open in Figma.
2. Select a frame.
3. Start a new Codex chat.
4. Send:

```text
Use FIGMA DESIGN AI. Check the connection and read the current selection.
```

5. Test a write:

```text
Use FIGMA DESIGN AI. Create a 200 by 200 green square in the viewport center.
```

6. Select **Apply changes** in Figma.

## Switching Figma files

Only one Figma file controls the local bridge at a time. Opening the plugin in another file moves the connection there. The previous panel shows **Other file** and stops reconnecting automatically, preventing connection thrashing. Select **Retry** in the file you want to make active.
