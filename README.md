# WFC Socket Tool

Client-side tool that reads an FBX of tile meshes and generates socket JSON for a Wave Function Collapse setup in Unity.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (synthetic meshes)
npm run build    # static site in dist/
```

Drop an FBX on the page (or a previously exported JSON to reuse its IDs). The help dialog (`?` in the toolbar) describes the socket rules, including the rotation rule your Unity code must implement.

## Notes

- **Units:** three.js's FBXLoader ignores the FBX `UnitScaleFactor`, but Unity applies it ("Convert Units"). The tool reads it and sets Scale to `UnitScaleFactor / 100` on load. Blender's default export needs 0.01.
- **Names:** FBXLoader normally rewrites object names (spaces become `_`, `.` and `:` are removed). The tool disables that, so `mesh_name` matches what Unity shows.
- **Axes:** "Blender default export" maps Unity = (-x, y, z) on the Y-up data FBXLoader produces. Use "Z-up file data" for files exported with Up = Z. Check the axis labels in the preview.
- **Format:** exports follow the WFC prototype format: sides read clockwise from above and match reversed; `posY`/`negY` ("Top / bottom" on) are 1-part (`A`) or 4-part (`B0|B1|B2|B3`) faces that match exactly and turn with the tile. With it off they're left out and Unity infers them from the sides. Imported `tags` (e.g. `LastResort`) are kept on export. After `prototypes`, a `boundary_sockets` section holds the Solve boundary: `outside`, `inside` (only with "Top / bottom" on), `bottom` and `top`; an empty string means any socket. Importing a JSON restores them. Meshes whose object origin is at height 0 (Unity Y, after scale and axis mapping) get `negY: "g"`, the ground socket, whether "Top / bottom" is on or off; `g` is reserved and never used as a vertical ID. Faces also carry inside/outside labels from a 4×4 grid of samples (front of the nearest surface = outside, back = inside), like the handmade `i`/`o`. "Empty tiles" adds `-1` prototypes: outside air, inside air, and (when some tile is at height 0) inside air on the ground, with `negY: "g"` so rooms can reach the bottom layer.
- **Solve preview:** the Solve tab runs Wave Function Collapse on the sockets as they would be exported, with the loader's rules (all four rotations, inferred faces, weight 0 and `LastResort` only as a fallback) and optional outside/inside/bottom/top boundary sockets. A failed solve marks the cell where the last attempt ran out of tiles in red.
- Code layout: `src/core` holds the pure, tested logic (profiles, IDs, rotation rule, import/export); `src/ui` and `src/main.ts` hold the UI.
