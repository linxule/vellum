# Phase B Checkpoint

## Allocation Inventory

- `src/loom/render/thread.ts:82` `ctx.createRadialGradient(...)`
  Decision: kept-intentionally.
  Notes: Canvas API object allocation, fixed-cost, only on `prox > 0.1`. Not a `loomState` scratch-buffer candidate.

- `src/loom/render/thread.ts:89` `const laidOutLines: LaidOutLine[] = []`
  Decision: needs-human-review.
  Notes: hot per-thread-per-frame allocation. Reusing this safely would require pooling a variable-length array of line records across the two-pass layout/render flow.

- `src/loom/render/thread.ts:144`
  `src/loom/render/thread.ts:147`
  `src/loom/render/thread.ts:148`
  `src/loom/render/thread.ts:172`
  `copyCursor(...)`
  Decision: kept-intentionally.
  Notes: these cursor objects must remain stable within the current frame after `voiceSpanForLine()` and later draw calls. Reuse would alias unless the whole line-record storage strategy changes.

- `src/loom/render/thread.ts:165-180` `laidOutLines.push({ ... })`
  Decision: needs-human-review.
  Notes: one object allocation per laid-out line, plus `lineVoiceUids: [...lineVoice.uids]` at `src/loom/render/thread.ts:174`. This is the largest remaining JS allocation site in the render path, but fixing it cleanly requires a broader object-pool design, not the simple typed-array scratch pattern from Phase A.

- `src/loom/render/line.ts:113` `Array.from(graphemeSegmenter.segment(segText), ...)`
  Decision: kept-intentionally.
  Notes: fallback path only. Normal hot path should hit `thread.segGraphemes.get(s)` from precomputed segment caches.

- `src/loom/render/line.ts:143`
  `src/loom/render/line.ts:144`
  `graphemes.slice(...).join('')`
  Decision: kept-intentionally.
  Notes: fallback path only, reached when the breakable-width fast path is unavailable or mismatched. Not a good Phase A-style scratch-buffer target.

## Scratch Buffers Added To `loomState`

- None in Phase B.

## Verification

### `bun test tests/loom/`

```text
bun test v1.2.12 (32a47ae4)
  78 pass
  0 fail
  449 expect() calls
Ran 78 tests across 18 files. [346.00ms]
```

### `bunx tsc --noEmit`

```text
(clean exit, no output)
```

### `bun run build`

```text
$ bun build src/main.ts --outdir dist --target browser --minify
Bundled 26 modules in 10ms

  main.js  68.60 KB  (entry point)
```

### `bun test tests/loom/alloc.test.ts`

```text
bun test v1.2.12 (32a47ae4)

tests/loom/alloc.test.ts:
(pass) advanceLoom reuses scratch buffers across frames at stable threadCount [12.94ms]
(pass) advanceLoom reallocates scratch buffers when threadCount changes [2.86ms]

  2 pass
  0 fail
  7 expect() calls
Ran 2 tests across 1 files. [29.00ms]
```

### `grep -n "new Float32Array" src/loom/render/thread.ts`

```text
(no matches)
```

### `grep -n "new Float32Array" src/loom/render/line.ts`

```text
(no matches)
```

## Notes

- I deliberately did not pool `laidOutLines` or the per-line cursor snapshots in this pass. That is the obvious future direction, but it is not the same low-risk scratch-buffer move as Phase A and it would be easy to break the current active-line / hover / draw ordering if rushed.
