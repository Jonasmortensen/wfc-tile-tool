# WFC Socket Tool

Client-side tool that reads an FBX of tile meshes and generates socket JSON for a Wave Function Collapse setup in Unity.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (synthetic meshes)
npm run build    # static site in dist/
```

Drop an FBX on the page (or a previously exported JSON to reuse its IDs). The help panel in the app describes the socket rules, including the rotation rule your Unity code must implement.

## Notes

- **Units:** three.js's FBXLoader ignores the FBX `UnitScaleFactor`, but Unity applies it ("Convert Units"). The tool reads it and sets Scale to `UnitScaleFactor / 100` on load. Blender's default export needs 0.01.
- **Names:** FBXLoader normally rewrites object names (spaces become `_`, `.` and `:` are removed). The tool disables that, so `mesh_name` matches what Unity shows.
- **Axes:** "Blender default export" maps Unity = (-x, y, z) on the Y-up data FBXLoader produces. Use "Z-up file data" for files exported with Up = Z. Check the axis labels in the preview.
- Code layout: `src/core` holds the pure, tested logic (profiles, IDs, rotation rule, import/export); `src/ui` and `src/main.ts` hold the UI.
