# Phase A Checkpoint

## Verification

### `bun test tests/loom/`

```text
bun test v1.2.12 (32a47ae4)
  78 pass
  0 fail
  449 expect() calls
Ran 78 tests across 18 files. [338.00ms]
```

### `bunx tsc --noEmit`

```text
(clean exit, no output)
```

### `bun run build`

```text
$ bun build src/main.ts --outdir dist --target browser --minify
Bundled 26 modules in 9ms

  main.js  68.60 KB  (entry point)
```

### `grep -n "new Float32Array" src/loom/render/frame.ts`

```text
87:    loomState.frameVisibilityAlpha = new Float32Array(threadCount)
91:    loomState.frameThreadSortDists = new Float32Array(threadCount)
94:    loomState.frameThreadAnchorXs = new Float32Array(threadCount)
97:    loomState.frameThreadRepulsionDeltas = new Float32Array(threadCount)
```

These are the guarded resize-on-count-change sites, not per-frame fresh allocations.

### `grep -n "new Int32Array" src/loom/render/frame.ts`

```text
90:    loomState.frameThreadSortIndices = new Int32Array(threadCount)
```

This is the guarded resize-on-count-change site.

### `grep -n "\.map(" src/loom/render/frame.ts`

```text
(no matches)
```

## Judgment Calls

- I kept the Phase A changes mechanical to the spec: the thread-distance ordering now uses an in-place insertion sort over `frameThreadSortIndices` + `frameThreadSortDists`, and the anchor / repulsion buffers now live on `loomState`.
- I did not rename any exports or change any public barrel surface.
- I extended `tests/loom/state.test.ts` so the existing reset-completeness test covers the new scratch-buffer fields explicitly.

## Surprises

- The functional contract is green, but the bundle moved from `67.99 KB` to `68.60 KB`, which is about `+0.61 KB` and therefore over the spec's `+0.50 KB` Phase A budget. The likely sources are the four new scratch-buffer fields plus the insertion-sort logic that replaced the prior `map(...).sort(...)` path.
- The `grep` contract in the spec conflicts slightly with the literal replacement snippet: guarded `new Float32Array(...)` / `new Int32Array(...)` lines still exist in `advanceLoom()` because resize-on-count-change still has to allocate somewhere. The hot-path regression is removed, but the file still contains resize-only allocation sites.
