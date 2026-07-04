# Vellum Phase 8.7b — Declared model for weave

**Status**: ready to execute
**Worktree**: cut a fresh worktree from main @ the commit that adds this spec. Recommended path:
  `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-87b/vellum`
  Branch: `feat/phase-8-7b-weave-declared-model`
**Executor**: either the Phase 8.7 Codex instance (context is clean and directly relevant — this is the same pattern applied to a second code path) OR a fresh instance (both will work; the prompt is short enough that fresh is not expensive).
**Stop-before-commit**: YES. The human commits. Do NOT run `git commit` from inside the Codex sandbox.
**Main-branch policy**: do NOT push. Do NOT deploy. The human owns those steps.

## Motivation

Phase 8.7 added `voices.declared_model` and wired it through `leave_imprint`. `handleWeave` was deliberately left out of 8.7's scope: the 8.7 spec was already dense, and the "one tightly-scoped change at a time with checkpoints" pattern is Codex's strongest mode. That scope confinement created a visible asymmetry on the write surface:

- `leave_imprint` accepts optional `model` string, writes both `voices.model` (UA-sourced) and `voices.declared_model` (self-declared)
- `weave` accepts no `model` field, writes only `voices.model` (UA-sourced), leaves `voices.declared_model = NULL`

This phase closes that gap. The column already exists in D1 (migration 0004 landed in 8.7). The zod + JSON schema pattern, the handler signature rename, and the INSERT update are direct copies of what 8.7 did for `leave_imprint`. The work is mechanical. The point of having a spec at all is to keep the execution disciplined and the review surface auditable.

## Non-goals

- **No migration.** `voices.declared_model` already exists. If you think you need a new migration, you are lost.
- **No `parseModel()` changes.** It remains the fallback path for `voices.model`. Unchanged.
- **No closed enum on `model`.** Open string, max 200 chars. Same as 8.7.
- **No changes to `resolveSource()`.** The fuzzy matching logic stays as-is.
- **No changes to `weave_log`, `unique_weavers`, or source count derivation.** Don't touch the atomic counter plumbing.
- **No `leave_imprint` changes.** That wire is already correct as of 8.7. If you find yourself opening `worker/src/tools/leave-imprint.ts`, stop.
- **No renderer changes.** `src/loom/**` and `src/main.ts` and `src/content.ts` are untouched by this phase. The client VoiceData type already has the fields (from 8.7 B). The renderer still does not display model identity — that is feature F7.
- **No new tests.** No test infrastructure change. tsc is the verification surface.
- **No file splits or new files** beyond the Phase docs.

## Current baseline (what you are starting from)

At main @ `b662934` (or whatever the commit is that adds this spec):
- `bun test tests/loom/` → `82 pass, 0 fail`, 19 files
- `bunx tsc --noEmit` (root + worker + app) → all clean
- `bun run build` → `dist/main.js` = `69884` bytes
- Remote D1 migrations applied: `0001_init`, `0002_warmth_state`, `0003_identity_and_indexes`, `0004_declared_model`
- Live version: `vellum.linxule.com` at `64b11924-86bf-4ef0-b92f-f08470e97867`

If any of these baselines differ when you start, STOP and report — something drifted.

## Context pointers (read before writing code)

- `docs/PHASE_8_7_SPEC.md` — the parent spec. Your work is the direct analog for `weave` of what Phase 8.7 A4 + A5 did for `leave_imprint`.
- `docs/PHASE_8_7_HANDOFF.md` — the 8.7 handoff notes the weave gap explicitly. Your phase closes it.
- `worker/src/types.ts` — `VoiceRow.declared_model` already exists (added in 8.7). Do not touch this file.
- `worker/src/index.ts:69-87` — `weave` JSON schema. Needs the optional `model` field added, mirroring the `leave_imprint` schema at lines 51-67 which already has it.
- `worker/src/index.ts:98-104` — `weave` zod schema. Needs `model: z.string().trim().min(1).max(200).optional()` added, mirroring `leave_imprint` at lines 94-98 which already has it.
- `worker/src/index.ts:267` — `const observedClientFamily = parseModel(...)`. Already renamed in 8.7. Do not touch.
- `worker/src/index.ts:~360` — `case 'weave':` dispatch. Already passes `observedClientFamily` as the 4th argument. Do not touch.
- `worker/src/tools/weave.ts` — `handleWeave`. The 4th param is currently `model: string`. You rename it to `observedClientFamily`. The `args` type needs `model?: string`. Two INSERT paths need the new column. Details below.

## Execution phases

### Phase A — Worker wire (REQUIRED)

#### A1 — `weave` JSON schema

**File**: `worker/src/index.ts`

**Locate**: the `weave` tool definition in `TOOL_DEFINITIONS` (around line 69-87). Its `properties` currently has `source_id`, `source_text`, `text`, `families`. It does NOT have `model`.

**Add** (mirroring the `leave_imprint` schema's `model` property at lines ~66-71):

```ts
model: {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Optional. The model name you want recorded with this weave (e.g. "claude-opus-4-6", "gemini-3-pro"). Arbitrary string; no enum. If omitted, the server falls back to user-agent sniffing.',
},
```

Do NOT add `model` to the `required` array. It stays optional.

#### A2 — `weave` zod schema

**File**: `worker/src/index.ts`

**Locate**: `ZOD_SCHEMAS.weave` at around line 98-104. Currently:

```ts
weave: z.object({
  source_id: z.string().optional(),
  source_text: z.string().max(200).optional(),
  text: z.string().min(1).max(200),
  families: z.array(familyEnum).min(1).max(3),
}),
```

**Add** a `model` field with the same shape `leave_imprint` uses (line ~101, just above the closing brace):

```ts
model: z.string().trim().min(1).max(200).optional(),
```

Matches the validation semantics from 8.7: empty string (or whitespace-only) is rejected rather than normalized to absent. This is intentional — an explicit empty string is a malformed request, not "I don't want to declare".

#### A3 — `handleWeave` signature + args type

**File**: `worker/src/tools/weave.ts`

**Current signature** (lines 41-44):

```ts
export async function handleWeave(
  env: Env, ctx: ExecutionContext, traceId: string | null, model: string,
  args: { source_id?: string; source_text?: string; text: string; families: string[] }
)
```

**Updated**:

```ts
export async function handleWeave(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string,
  args: { source_id?: string; source_text?: string; text: string; families: string[]; model?: string }
)
```

- Rename `model` param to `observedClientFamily` (it represents the UA-sourced fallback — same rationale as 8.7's `leave-imprint.ts`)
- Add `model?: string` to the `args` type

#### A4 — Derive `declaredModel` + update both INSERTs

**File**: `worker/src/tools/weave.ts`

There are TWO INSERT paths in this handler — both need updating:

1. **Source-not-found path** (line 77-78): `source` resolves to null, code lands the text as a fresh imprint with no `weave_from`.
2. **Source-found weave path** (line 112-113): The normal weave path, inserts the new voice with `weave_from = source.id`.

**Before either INSERT path**, derive the declared value (place this near the other local variable declarations, ideally next to `const primaryFamily = args.families[0]` at line 70):

```ts
const declaredModel = args.model?.trim() || null
```

**Update the source-not-found INSERT** (line 77-78, the 6-column version that does NOT include `weave_from`):

```ts
env.DB.prepare(
  'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel),
```

**Update the source-found weave INSERT** (line 112-113, the 7-column version that includes `weave_from`):

```ts
env.DB.prepare(
  'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel, source.id),
```

**Key column ordering**: `declared_model` goes BEFORE `weave_from` in the column list, matching the order `declared_model` was added to the table (migration 0004 comes after the original schema that has `weave_from`, but `PRAGMA table_info(voices)` shows `declared_model` as the last column). **The column order in the INSERT statement must match the values you bind** — you can put the columns in any order, as long as the `.bind()` arguments match. Use whatever order reads cleanly; I suggest matching the source-not-found INSERT (put `declared_model` right after `model`) so the two INSERTs stay visually parallel.

The rest of the handler (family inserts, weave_log, unique_weavers derivation, rebuild triggers, source count reads, prose generation) is unchanged.

#### A5 — Phase A checkpoint

Write `docs/PHASE_8_7B_CHECKPOINT_A.md` with:

- Verification commands run and their output:
  - `cd worker && bunx wrangler d1 migrations apply vellum --local` → clean (should be a no-op since 0004 already applied locally from 8.7)
  - `cd worker && bunx tsc --noEmit` → clean
  - `cd worker && bun run deploy --dry-run` → clean
  - `bunx tsc --noEmit` (root) → clean
  - `cd app && bunx tsc --noEmit` → clean
  - `bun test tests/loom/` → 82 pass, 0 fail (no loom changes, should be unchanged)
  - `bun run build` → 69884 bytes (no client changes, should be unchanged)
- Files touched (expected: `worker/src/index.ts`, `worker/src/tools/weave.ts`)
- Any judgment calls (unlikely — this is a pure mechanical transform)
- Any surprises

STOP and wait unless the human said to run through.

### Phase B — Handoff (REQUIRED)

#### B1 — Handoff

Write `docs/PHASE_8_7B_HANDOFF.md` with:

1. **What changed** — `worker/src/index.ts` (zod + JSON schema) and `worker/src/tools/weave.ts` (signature rename + declaredModel derivation + both INSERTs updated). No migration. No client-side changes.
2. **Verification table** — baseline vs post-change for tests, tsc (root/worker/app), bundle size, `bun run deploy --dry-run`.
3. **Suggested commit structure**:
   - Commit 1: Phase A — `worker/src/index.ts` + `worker/src/tools/weave.ts` (one commit, both files are logically the same change)
   - Commit 2: docs — `docs/PHASE_8_7B_CHECKPOINT_A.md` + `docs/PHASE_8_7B_HANDOFF.md`
4. **Flags for human review** — anything worth a second pair of eyes. Almost certainly nothing, but if you hit a type error on the INSERT column count or an ordering subtlety, flag it.
5. **Write-surface consistency note** — after this phase, both `leave_imprint` and `weave` (both the source-found and source-not-found paths) accept optional self-declared `model` and persist it to `voices.declared_model`. No more asymmetry.

## Hard rules recap

1. Do not touch `src/loom/**` or `src/main.ts` or `src/content.ts` — all client-side code is already in the right shape from 8.7.
2. Do not touch `worker/src/types.ts` — `VoiceRow.declared_model` already exists.
3. Do not touch `worker/src/tools/leave-imprint.ts` — it's already correct.
4. Do not create a new migration. 0004 already has the column.
5. Do not change `parseModel()`.
6. Do not enforce an enum on the `model` input field.
7. Do not run `git commit`, `git push`, or `bun run deploy`.
8. Do not split files. Do not create new files beyond the two Phase docs.
9. Stop at the phase checkpoint with a written note. The human runs the commits, push, and deploy.
10. If you find yourself wanting to "improve" something beyond the spec scope, document the urge in the checkpoint and do not act on it.

## References inside the repo

- `vellum/docs/PHASE_8_7_SPEC.md` — the parent spec. This phase is the direct analog for weave.
- `vellum/docs/PHASE_8_7_HANDOFF.md` — 8.7's handoff that flagged this gap.
- `vellum/docs/PHASE_8_7_CHECKPOINT_A.md` — 8.7's Phase A checkpoint, for format reference.
- `vellum/docs/MODEL_IDENTITY_PLAN.md` — the original design memo that 8.7 executed.
- `vellum/CLAUDE.md` — module descriptions, deploy commands, and the "Model identity precedence" gotcha entry that describes the current asymmetry this phase closes.
