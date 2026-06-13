---
name: excalidraw
description: |
  Create and edit hand-drawn-style diagrams as Excalidraw files in the workspace. Use this skill whenever the user wants to draw, diagram, sketch, or visualize something — a flowchart, architecture diagram, system design, sequence of steps, mind map, wireframe, org chart, entity-relationship sketch, or any boxes-and-arrows picture. Also use when they say "draw me a…", "make a diagram of…", "sketch out…", "visualize…", "show this as a diagram", or ask to modify an existing `.excalidraw` file. Write the diagram as a `.excalidraw` file in the workspace; the user opens it in Shockwave's drawing canvas, where it is fully editable. Do NOT use for prose, tables, or code — only for visual diagrams.
---

# Excalidraw diagrams

You produce diagrams by writing a `.excalidraw` JSON file into the workspace. The
file IS the diagram — Shockwave renders `.excalidraw` files in an editable canvas.
There is no render/preview command and no API to call: write the file, tell the
user its name, and they open it from the file tree.

## Workflow

1. Decide the elements and a rough layout (positions, sizes) before writing.
2. Write a `.excalidraw` file with a descriptive name into the relevant folder —
   default to the same folder as the file under discussion, else the workspace
   root. Example: `Auth flow.excalidraw`.
3. To EDIT an existing diagram, read the file, modify the `elements` array, and
   write it back. If the file is open in Shockwave, the canvas reloads live.

Use your normal file-writing tools. Always write valid JSON (no comments, no
trailing commas) or the canvas can't open it.

## File envelope

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "shockwave",
  "elements": [ /* ordered back-to-front; later elements draw on top */ ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {}
}
```

## Element schema

Every element — whatever its type — must include ALL of these fields. Missing
fields can make the canvas drop the element or fail to open.

```json
{
  "id": "unique-string",
  "type": "rectangle",
  "x": 100, "y": 100, "width": 200, "height": 100,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "roundness": { "type": 3 },
  "seed": 12345,
  "version": 1,
  "versionNonce": 1,
  "isDeleted": false,
  "boundElements": [],
  "updated": 1,
  "link": null,
  "locked": false
}
```

- `id` — any string, unique within the file. Use readable ids (`box-auth`, `arrow-1`).
- `seed` / `versionNonce` — any integers; give each element different values.
- `roundness` — `{ "type": 3 }` for rounded corners, or `null` for sharp. Ellipses use `null`.
- Colors — use Excalidraw's palette: stroke `#1e1e1e` (black), `#1971c2` (blue),
  `#e03131` (red), `#2f9e44` (green), `#f08c00` (orange), `#9c36b5` (purple).
  Backgrounds are the light tints: `#a5d8ff`, `#ffc9c9`, `#b2f2bb`, `#ffec99`, `#eebefa`, or `transparent`.

### Shapes

`rectangle`, `ellipse`, `diamond` — use the fields above as-is.

### Text

```json
{
  "id": "label-1", "type": "text",
  "x": 120, "y": 130, "width": 160, "height": 25, "angle": 0,
  "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
  "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid",
  "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null,
  "roundness": null, "seed": 222, "version": 1, "versionNonce": 222,
  "isDeleted": false, "boundElements": [], "updated": 1, "link": null, "locked": false,
  "text": "Login", "fontSize": 20, "fontFamily": 1,
  "textAlign": "center", "verticalAlign": "middle",
  "containerId": null, "originalText": "Login", "lineHeight": 1.25
}
```

- `fontFamily`: `1` = hand-drawn (Excalifont), `2` = normal, `3` = code.
- Estimate `width` ≈ `text.length * fontSize * 0.6`, `height` ≈ `fontSize * 1.25`.

To center a label INSIDE a shape, bind them: set the text's `containerId` to the
shape's `id`, and add `{ "id": "<text-id>", "type": "text" }` to the shape's
`boundElements`. The canvas then auto-centers the text in the shape.

### Arrows and lines

```json
{
  "id": "arrow-1", "type": "arrow",
  "x": 300, "y": 150, "width": 80, "height": 0, "angle": 0,
  "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
  "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid",
  "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null,
  "roundness": { "type": 2 }, "seed": 333, "version": 1, "versionNonce": 333,
  "isDeleted": false, "boundElements": [], "updated": 1, "link": null, "locked": false,
  "points": [[0, 0], [80, 0]],
  "startBinding": { "elementId": "box-a", "focus": 0, "gap": 4 },
  "endBinding": { "elementId": "box-b", "focus": 0, "gap": 4 },
  "startArrowhead": null, "endArrowhead": "arrow"
}
```

- `points` are RELATIVE to the arrow's `x`/`y`; first is usually `[0,0]`.
- `width`/`height` is the bounding box of the points.
- To connect two shapes, set `startBinding`/`endBinding` to their ids AND add
  `{ "id": "<arrow-id>", "type": "arrow" }` to BOTH shapes' `boundElements`.
  Then the arrow stays attached when shapes move. Use `focus: 0`, `gap: 4` as
  safe defaults. Omit bindings (`null`) for free-floating arrows.

## Layout rules

- Lay shapes on a grid; leave ≥ 60px gaps so arrows have room and nothing overlaps.
- Standard box: ~160–220 wide, ~80–100 tall. Keep sizes consistent.
- Flow left→right or top→bottom. Put arrowheads on the destination end.
- Label every arrow that isn't obvious (a small `text` element near its midpoint).
- Order `elements` back-to-front: shapes first, then arrows, then text/labels on top.

## Worked example — two boxes and a labelled arrow

```json
{
  "type": "excalidraw", "version": 2, "source": "shockwave",
  "elements": [
    { "id": "box-a", "type": "rectangle", "x": 100, "y": 100, "width": 180, "height": 90, "angle": 0, "strokeColor": "#1971c2", "backgroundColor": "#a5d8ff", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null, "roundness": { "type": 3 }, "seed": 11, "version": 1, "versionNonce": 11, "isDeleted": false, "boundElements": [{ "id": "t-a", "type": "text" }, { "id": "arrow-1", "type": "arrow" }], "updated": 1, "link": null, "locked": false },
    { "id": "t-a", "type": "text", "x": 130, "y": 132, "width": 120, "height": 25, "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null, "roundness": null, "seed": 12, "version": 1, "versionNonce": 12, "isDeleted": false, "boundElements": [], "updated": 1, "link": null, "locked": false, "text": "Client", "fontSize": 20, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "box-a", "originalText": "Client", "lineHeight": 1.25 },
    { "id": "box-b", "type": "rectangle", "x": 420, "y": 100, "width": 180, "height": 90, "angle": 0, "strokeColor": "#2f9e44", "backgroundColor": "#b2f2bb", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null, "roundness": { "type": 3 }, "seed": 21, "version": 1, "versionNonce": 21, "isDeleted": false, "boundElements": [{ "id": "t-b", "type": "text" }, { "id": "arrow-1", "type": "arrow" }], "updated": 1, "link": null, "locked": false },
    { "id": "t-b", "type": "text", "x": 450, "y": 132, "width": 120, "height": 25, "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null, "roundness": null, "seed": 22, "version": 1, "versionNonce": 22, "isDeleted": false, "boundElements": [], "updated": 1, "link": null, "locked": false, "text": "Server", "fontSize": 20, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "box-b", "originalText": "Server", "lineHeight": 1.25 },
    { "id": "arrow-1", "type": "arrow", "x": 282, "y": 145, "width": 136, "height": 0, "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": null, "roundness": { "type": 2 }, "seed": 31, "version": 1, "versionNonce": 31, "isDeleted": false, "boundElements": [], "updated": 1, "link": null, "locked": false, "points": [[0, 0], [136, 0]], "startBinding": { "elementId": "box-a", "focus": 0, "gap": 4 }, "endBinding": { "elementId": "box-b", "focus": 0, "gap": 4 }, "startArrowhead": null, "endArrowhead": "arrow" }
  ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {}
}
```

After writing, tell the user the filename and that they can open it from the file
tree to view and edit it.
