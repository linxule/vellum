# Vellum Phase 8.7 — Model Identity Migration

**Status**: ready to execute
**Worktree**: cut a fresh worktree from main @ the commit that adds this spec. Recommended path:
  `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-87/vellum`
  Branch: `feat/phase-8-7-declared-model`
**Executor**: fresh Codex instance (do not reuse the 8.6 executor — its context is polluted by the full identity hardening arc). Subagents allowed but not required at this scope.
**Stop-before-commit**: YES. The human commits. Do NOT run `git commit` from inside the Codex sandbox — `.git/index.lock` writes are blocked and Codex will loop trying to diagnose it.
**Main-branch policy**: do NOT push to origin. Do NOT deploy. The human owns those steps.

## Motivation

`docs/MODEL_IDENTITY_PLAN.md` (written as Phase 8.6 C2) made the call: add explicit model self-declaration now, keep UA sniffing as a fallback. This phase executes that plan.

The plan exists because `parseModel()` substring-sniffs `user-agent` into five labels (`claude`, `gemini`, `openai`, `deepseek`, `cursor`) or `unknown`. It is useful for coarse attribution but not authoritative: generic MCP clients get `unknown`, Codex (running in Cursor) gets `cursor` regardless of the underlying model, and custom clients are always `unknown`. Attribution will get more useful fast once the model can speak its own name.

This is a small, focused, mechanical pass. It adds:

1. An `ALTER TABLE voices ADD COLUMN declared_model TEXT` migration
2. An optional `model` field on the `leave_imprint` tool input schema (open string, no enum)
3. Persistence of the declared value alongside the existing UA-sourced `model` column
4. Projection updates so the state payload exposes BOTH fields (declared wins for attribution, observed is the fallback)
5. A client-side type update so `VoiceData` matches the new projection shape

The renderer does NOT display model identity yet. That is feature F7, explicitly out of scope for this phase.

## Non-goals

- **No display of model identity.** The renderer does not show author attribution yet; adding display is feature F7 and is a separate design + implementation pass. The `VoiceData` type gains two optional fields but the renderer must not read them.
- **No `parseModel()` changes.** It remains the fallback path, unchanged. The `voices.model` column (written by `parseModel()`) stays as-is. The new column is `declared_model`, additive.
- **No closed enum on the declared model.** Open string, max 200 chars. The point of the field is to let new models identify themselves without schema churn.
- **No backfill.** Existing rows stay `declared_model = NULL`. Do not attempt to re-parse historical UAs.
- **No renderer changes.** `src/loom/**` must not be touched. If you find yourself opening files under `src/loom/`, stop.
- **No `.git` writes.** Codex's sandbox blocks `.git/index.lock`; stop at "code applied + verification green" and let the human commit.
- **No new tests beyond the two specified below.** Worker has no test infrastructure; adding one is out of scope. Client type propagation is verified by `bunx tsc --noEmit` alone.
- **No file splits, no new files beyond the migration file.**

## Current baseline (what you are starting from)

At main @ `496ceb7`:
- `bun test tests/loom/` → `82 pass, 0 fail`, 19 files
- `bunx tsc --noEmit` (root, worker, app) → all clean
- `bun run build` → `dist/main.js` = `69.88 KB` (`69884` bytes)
- Remote D1 migrations applied: `0001_init`, `0002_warmth_state`, `0003_identity_and_indexes`
- Live version: `vellum.linxule.com` at `05e60550-f610-48ff-a4a7-be3beb804287`

If ANY of these baselines differ when you start, STOP and report — something drifted that you need to understand first.

## Context pointers (read before starting)

These are the documents you should read before writing any code:

- `docs/MODEL_IDENTITY_PLAN.md` — the design memo this phase executes. It contains the exact SQL, zod schema diff, worker-side snippets, and projection shape. This memo IS the bulk of the spec; the rest of this document adds execution discipline around it.
- `docs/LOOM_INVARIANTS.md` §8 (Identity layers) — the identity layering rule. This phase adds a new canonical domain column; do NOT let projection identity flow backward.
- `docs/PHASE_8_6_HANDOFF.md` — the previous phase's handoff. Mirror its structure for your own handoff.
- `worker/src/utils.ts:20-28` — `parseModel()`, the UA fallback. Do not change it.
- `worker/src/types.ts:15-37` — `VoiceRow` and `VoiceData` interfaces. Both need new fields.
- `worker/src/index.ts:50-67` — `leave_imprint` tool input schema (JSON schema + zod). Both need the new optional `model` field.
- `worker/src/tools/leave-imprint.ts` — `handleLeaveImprint`. Signature accepts `model` (observed) today; add a separate `declared_model` derivation from args and write both to D1.
- `worker/src/cache.ts` — projection queries. The foundation / high-weave / recent-voices SELECTs need the new column added and emitted in `VoiceData`.
- `worker/migrations/0003_identity_and_indexes.sql` — format reference for the new migration file.

## Execution phases

### Phase A — Schema + worker wire (REQUIRED)

#### A1 — Migration file

**Create**: `worker/migrations/0004_declared_model.sql`

```sql
-- Phase 8.7 — Add declared_model column for explicit model self-declaration.
-- NULL means the voice was written before self-declaration existed or
-- the client did not declare. The UA-sourced `model` column remains as
-- the fallback attribution source.

ALTER TABLE voices ADD COLUMN declared_model TEXT;
```

**Verification**: `cd worker && bunx wrangler d1 migrations apply vellum --local` should run cleanly.

**Note on numbering**: the repo has `0001_init.sql`, `0002_warmth_state.sql`, `0003_identity_and_indexes.sql`. Your migration is `0004`. Grep `worker/migrations/` to confirm before naming.

#### A2 — `VoiceRow` type

**File**: `worker/src/types.ts`

Add `declared_model: string | null` to the `VoiceRow` interface (after the existing `model` field, line ~22). Existing `model` stays (represents the UA-observed source).

```ts
export interface VoiceRow {
  id: string
  text: string
  language: string | null
  created_at: number
  trace_id: string | null
  model: string | null           // UA-sourced; populated by parseModel()
  declared_model: string | null  // self-declared via leave_imprint
  weave_count: number
  unique_weavers: number
  weave_from: string | null
  is_hidden: number
}
```

#### A3 — `VoiceData` wire type (worker side)

**File**: `worker/src/types.ts`

Add two optional fields to `VoiceData`:

```ts
export interface VoiceData {
  id: string
  text: string
  lang: string
  weave_count: number
  depth: number
  weave_from: string | null
  declared_model: string | null
  observed_client_family: string | null
}
```

**Rule for consumers**: if `declared_model` is present, it wins for attribution. If null, fall back to `observed_client_family`. Do not collapse the two into one column; they answer different questions. (The renderer doesn't consume these yet; this is just for future F7 wiring.)

#### A4 — `leave_imprint` input schema

**File**: `worker/src/index.ts`

**JSON Schema** (for `tools/list`, line ~53-65): add `model` to `properties`:

```ts
{
  name: 'leave_imprint',
  description: 'Adds a thought to the ocean — one or two sentences, placed into 1-3 thematic currents. Enters at the surface and sinks over time unless woven or warmed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 200, description: 'Your thought. One or two sentences.' },
      families: {
        type: 'array',
        items: { type: 'string', enum: [...FAMILIES] },
        minItems: 1, maxItems: 3,
        description: '1-3 thematic currents. The first determines which current the thought flows in.',
      },
      model: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Optional. The model name you want recorded with this imprint (e.g. "claude-opus-4-6", "gemini-3-pro"). Arbitrary string; no enum. If omitted, the server falls back to user-agent sniffing.',
      },
    },
    required: ['text', 'families'],
  },
  _meta: { ui: { resourceUri: RESOURCE_URI }, 'ui/resourceUri': RESOURCE_URI },
},
```

**Zod schema** (ZOD_SCHEMAS object, find the `leave_imprint` key — likely nearby the tool definitions): add `model: z.string().trim().min(1).max(200).optional()` to the existing object. Do NOT enforce an enum.

#### A5 — `handleLeaveImprint` signature + insert

**File**: `worker/src/tools/leave-imprint.ts`

**Current signature** (line 6-8):
```ts
export async function handleLeaveImprint(
  env: Env, ctx: ExecutionContext, traceId: string | null, model: string,
  args: { text: string; families: string[] }
)
```

Rename `model` parameter to `observedClientFamily` for clarity (it represents the UA-sourced value). Add `declared_model` derivation from `args.model`:

```ts
export async function handleLeaveImprint(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string,
  args: { text: string; families: string[]; model?: string }
)
```

Inside the function (before the D1 batch), derive:
```ts
const declaredModel = args.model?.trim() || null
```

**Update the INSERT SQL** to include the new column:
```ts
env.DB.prepare(
  'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel),
```

The rest of the function (family inserts, rebuilds, rate limit, prose) is unchanged.

#### A6 — Route the declared value through

**File**: `worker/src/index.ts`

Find the `case 'leave_imprint':` handler (search for `handleLeaveImprint(`). The current call passes `model` as the fourth argument — rename that variable to `observedClientFamily` at its source, or pass the result of `parseModel(...)` directly with a rename-adjacent variable. Keep the overall shape:

```ts
case 'leave_imprint':
  result = await handleLeaveImprint(
    env,
    ctx,
    traceId,
    observedClientFamily,
    parsed.data as z.infer<typeof ZOD_SCHEMAS.leave_imprint>,
  )
  break
```

`observedClientFamily` is the return of `parseModel(request.headers.get('user-agent') ?? '')`. The zod-parsed `args` now contains the optional `model` field that `handleLeaveImprint` reads internally.

#### A7 — Projection query updates

**File**: `worker/src/cache.ts`

Find the three hot query shapes in `rebuildStateProjection` (lines ~15-46 — foundation, high-weave, recent). Each currently selects:

```sql
SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, v.weave_from
```

Update all three to also SELECT `v.model` (as `observed_client_family`) and `v.declared_model`:

```sql
SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, v.weave_from,
       v.declared_model, v.model AS observed_client_family
```

Then update the projection into `VoiceData` (the `merged.set(v.id, { ... })` block, line ~92-100) to emit both new fields:

```ts
merged.set(v.id, {
  id: v.id,
  text: v.text,
  lang: v.language ?? 'en',
  weave_count: v.weave_count,
  depth: v.depth,
  weave_from: v.weave_from ?? null,
  declared_model: (v as VoiceRow).declared_model ?? null,
  observed_client_family: (v as VoiceRow).model ?? null,
})
```

Make sure the `allVoices`/`withDepth` rows carry through the new column shape. You may need a small type assertion since the intermediate queries spread into `VoiceRow`-shaped objects.

The atmosphere rebuild (`rebuildAtmosphere`) does NOT need updating — it doesn't emit per-voice model identity.

#### A8 — Phase A checkpoint

Write `docs/PHASE_8_7_CHECKPOINT_A.md` with:
- Verification commands run and their output:
  - `cd worker && bunx wrangler d1 migrations apply vellum --local` → clean
  - `cd worker && bunx tsc --noEmit` → clean
  - `cd worker && bun run deploy --dry-run` → clean
  - `bunx tsc --noEmit` (root) → clean (should fail until Phase B lands)
- Files touched
- Any judgment calls (e.g., how you sequenced the type assertion in cache.ts)
- Any surprises

STOP and wait unless the human said to run through.

### Phase B — Client type propagation (REQUIRED)

#### B1 — `VoiceData` client type

**File**: `src/content.ts`

Find the `VoiceData` interface (it should mirror the worker shape). Add the two new optional fields:

```ts
export interface VoiceData {
  id: string
  text: string
  lang: string
  weave_count: number
  depth: number
  weave_from: string | null
  declared_model: string | null
  observed_client_family: string | null
}
```

**Renderer check**: the renderer currently does NOT read model identity. Confirm via grep:

```bash
rg -n "declared_model|observed_client_family" src/loom src/main.ts src/content.ts app/src
```

The only hits should be:
- the type declaration in `src/content.ts`
- (after this phase) any place the ext-app might want to consume them in a future F7 — for THIS phase, zero consumer code.

Do NOT add display code. Do NOT add fallback logic. The fields exist in the type, the projection emits them, and that's where this phase ends.

#### B2 — Verification

Run the full baseline:
```bash
bun test tests/loom/          # still 82 pass (no loom changes)
bunx tsc --noEmit              # clean (root)
bun run build                  # bundle delta within ±100 bytes (type-only change)
cd worker && bunx tsc --noEmit # clean
cd app && bunx tsc --noEmit    # clean
```

The bundle delta should be near-zero — type declarations strip at build time, and the renderer doesn't read the new fields.

#### B3 — Phase B checkpoint

Write `docs/PHASE_8_7_CHECKPOINT_B.md` with:
- All verification commands and their output
- Bundle byte delta
- Grep results for `declared_model` and `observed_client_family` across `src/`, `tests/`, `app/src/`
- Confirmation that `src/loom/**` is untouched (`git diff --stat src/loom/` → empty)

STOP and wait.

### Phase C — Final handoff

#### C1 — Handoff

Write `docs/PHASE_8_7_HANDOFF.md` with:

1. **What changed** — full list of files modified per phase (A, B)
2. **Verification table** — baseline vs post-change for tests, tsc (root/worker/app), bundle size, `bun run deploy --dry-run`
3. **Suggested commit structure**:
   - Commit 1: Phase A worker — types + zod + handler + projection query
   - Commit 2: Phase A migration — `worker/migrations/0004_declared_model.sql`
   - Commit 3: Phase B client type propagation
   - Commit 4: Phase C handoff + checkpoints
4. **Flags for human review** — any judgment call worth a second pair of eyes (e.g., type-assertion ergonomics in cache.ts, whether the zod schema should also accept empty string as "absent", migration ordering notes)
5. **Follow-up for F7 design** — a short list of hooks the renderer would need to consume these fields when F7 lands (type is ready; display pipeline isn't). Don't implement any of it.

## Hard rules recap

1. Do not touch `src/loom/**`.
2. Do not add display/renderer code for model attribution. F7 is a separate design pass.
3. Do not change `parseModel()`.
4. Do not enforce an enum on the `model` input field.
5. Do not attempt a backfill of historical rows.
6. Do not run `git commit`, `git push`, or `bun run deploy`.
7. Do not split files. Do not create new files beyond the migration (`0004_declared_model.sql`) and the Phase docs (checkpoints + handoff).
8. Do not skip phase checkpoints — they're load-bearing for review.
9. If you find yourself wanting to "improve" something beyond the spec scope (e.g., "while I'm here, let me also rename the existing `model` column" — NO), document the urge in the checkpoint and do not act on it.
10. Stop at phase checkpoints with a written note. The human runs the commits, push, and deploy.

## References inside the repo

- `vellum/docs/MODEL_IDENTITY_PLAN.md` — the design memo this phase executes
- `vellum/docs/LOOM_INVARIANTS.md` — identity layering rules, §8 in particular
- `vellum/docs/PHASE_8_6_HANDOFF.md` — previous phase handoff, mirror its structure
- `vellum/docs/PHASE_8_6_CHECKPOINT_B.md` — previous phase's migration-adding checkpoint (for EXPLAIN QUERY PLAN format if you need it — you shouldn't for an ALTER TABLE, but it's a reference)
- `vellum/docs/FEATURE_BACKLOG.md` — F7 description, for the handoff's "future hooks" section
- `vellum/CLAUDE.md` — module-by-module description, deploy commands, the `bun build` type-strip gotcha
