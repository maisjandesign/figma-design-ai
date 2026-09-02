# DesignIR 0.1

DesignIR is the small, deterministic JSON format used to create Figma nodes. It intentionally does not contain executable code.

## Example

```json
{
  "type": "FRAME",
  "name": "Profile card",
  "width": 360,
  "height": 180,
  "layoutMode": "VERTICAL",
  "padding": 24,
  "itemSpacing": 12,
  "fill": "#FFFFFF",
  "cornerRadius": 20,
  "children": [
    {
      "type": "TEXT",
      "name": "Title",
      "characters": "Ada Lovelace",
      "fontFamily": "Inter",
      "fontStyle": "Regular",
      "fontSize": 24,
      "fill": "#111827",
      "textAutoResize": "WIDTH_AND_HEIGHT"
    },
    {
      "type": "TEXT",
      "name": "Description",
      "characters": "Mathematician and writer",
      "fontSize": 14,
      "fill": "#6B7280",
      "textAutoResize": "WIDTH_AND_HEIGHT"
    }
  ]
}
```

## Supported node types

- `FRAME`
- `COMPONENT`
- `TEXT`
- `RECTANGLE`
- `ELLIPSE`
- `LINE`

Unknown types are rejected. Every node created by the bridge receives a private `figmaLocalBridgeId` in Figma plugin data.

## Patch operations

Patch targets are limited to the current selection and its descendants.

```json
{
  "operations": [
    { "targetNodeId": "12:34", "op": "set_text", "value": "New label" },
    { "targetNodeId": "12:35", "op": "set_fill", "value": "#7C3AED" },
    { "targetNodeId": "12:36", "op": "resize", "width": 320, "height": 48 }
  ]
}
```

Supported operations: `set_name`, `set_text`, `resize`, `move`, `set_fill`, `set_opacity`, `set_corner_radius`, and `set_visibility`.
