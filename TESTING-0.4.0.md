# Test release 0.4.0

## Install the Figma plugin

1. Extract the ZIP into a permanent folder. Keep `manifest.json`, `code.js` and `ui.html` together.
2. In Figma desktop, close any running FIGMA DESIGN AI panel.
3. Choose **Plugins > Development > Import plugin from manifest…** and select the extracted root `manifest.json`.
4. Run the plugin from this development entry. If Figma still uses the previous entry, remove that development registration and import the new manifest. This does not delete your design layers.

## Update the Codex companion

Both the Figma plugin and Codex connector must be updated. This archive includes the connector source in `codex-connector/`.

On the development Mac, connector 0.4.0 has already been installed. Fully quit and reopen Codex to stop the old shared bridge, then start a new task to load the new tools. Restart the Figma plugin too.

On another machine, install `codex-connector/` through a local Codex plugin marketplace first; importing the Figma manifest alone does not install the Codex companion. See `README.md` and `codex-connector/README.md`.

## Verify a real frame

Select a frame with nested layers, mixed-style text, photos and icons. Send this prompt in a new Codex task:

> Use FIGMA-DESIGN-AI. Read the selected frame with figma_get_design_context, continuing with nextCursor until complete is true. Report the total layer count, layout and text information, and image/vector asset references. Export one photo and one icon using figma_export_asset into an assets directory in this project. Do not implement the design yet.

Check that:

- The read reaches `complete: true` and includes deeply nested children.
- Text remains text and retains mixed-style runs.
- Photos and icons are separate files, mapped to their layer IDs.
- The selection and design layers remain unchanged.
- Changing the document during pagination invalidates the cursor and prompts a fresh read.

If a tool is missing or an unknown-command error appears, confirm both parts are updated and restart Codex and the Figma plugin. Do not fall back to screenshot-only implementation.

## Automated checks

Requires Node.js 22+ (including its built-in WebSocket client):

```sh
node codex-connector/scripts/context-test.mjs
node codex-connector/scripts/smoke-test.mjs
```

The context test uses a mocked Figma document with 1,604 layers and 1,600 levels. The smoke test uses two local MCP processes and a mocked Figma client. These checks do not replace testing in the real Figma desktop app.
