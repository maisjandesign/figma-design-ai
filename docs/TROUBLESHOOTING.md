# Troubleshooting

## Offline

1. Confirm that Codex is open.
2. Start a new Codex chat after installing or updating the companion.
3. Ask Codex to use FIGMA DESIGN AI.
4. Select **Retry** in the Figma plugin.

The plugin also retries automatically with a capped backoff.

## Other file

Another Figma file currently owns the bridge. Select **Retry** in the file you want to use. The other file will stop reconnecting until you explicitly switch back.

## Update needed

The Figma plugin and the Codex companion use different protocol versions. Update both from the same repository revision, reinstall the Codex companion, restart Codex, and reopen the Figma plugin.

## New chat cannot see Figma

Use connector version 0.2.0 or later. Multiple chats share one bridge; they should never request different ports. If an older connector still owns the bridge, quit and reopen Codex once to stop the old process.

## A write is waiting

Writes never apply silently. Review the summary in the plugin and select **Apply changes** or **Reject**. Codex times out if no decision is made within the write approval window.

## Empty selection

Select a frame or layer in the active Figma file. With automatic sync enabled, the selection snapshot is sent immediately. You can also select **Sync selection**.

## Local security check

The expected bridge endpoint is loopback-only. Do not expand the Figma manifest allowlist or expose the bridge to a LAN address.
