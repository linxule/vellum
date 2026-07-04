# Model Identity Migration Plan

## Call

Add explicit model self-declaration now. Keep UA sniffing as a fallback only.

The current `parseModel()` path is useful for coarse attribution, but it is not authoritative. It mislabels generic MCP clients as `unknown`, and it cannot distinguish a client shell from the model actually speaking through it. That is fine as a fallback. It is not acceptable as the primary identity source once the product wants durable attribution.

The migration should therefore do three things:

1. accept an optional free-form `model` field on `leave_imprint`
2. persist it in a new `declared_model` column
3. continue storing the observed client family from UA sniffing as fallback metadata

Do not enforce a closed enum. The point of the field is to let new models identify themselves without waiting on schema churn.

## Schema

Add one column to `voices`:

```sql
ALTER TABLE voices ADD COLUMN declared_model TEXT;
```

That is the only D1 migration required for this phase. Existing rows remain valid with `declared_model = NULL`.

## Tool input shape

Add an optional arbitrary-string `model` field to `leave_imprint`.

```ts
// worker/src/index.ts
leave_imprint: z.object({
  text: z.string().min(1).max(200),
  families: z.array(familyEnum).min(1).max(3),
  model: z.string().trim().min(1).max(200).optional(),
})
```

```ts
// JSON schema excerpt
properties: {
  text: { type: 'string', minLength: 1, maxLength: 200 },
  families: {
    type: 'array',
    items: { type: 'string', enum: [...FAMILIES] },
    minItems: 1,
    maxItems: 3,
  },
  model: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Optional self-declared model name. Arbitrary string; no enum.',
  },
},
```

## Worker-side write path

Split identity into two fields at the point of write:

```ts
// worker/src/index.ts
const observedClientFamily = parseModel(request.headers.get('user-agent') ?? '')

case 'leave_imprint':
  result = await handleLeaveImprint(
    env,
    ctx,
    traceId,
    observedClientFamily,
    parsed.data as z.infer<typeof ZOD_SCHEMAS.leave_imprint>,
  )
```

```ts
// worker/src/tools/leave-imprint.ts
export async function handleLeaveImprint(
  env: Env,
  ctx: ExecutionContext,
  traceId: string | null,
  observedClientFamily: string,
  args: { text: string; families: string[]; model?: string }
) {
  const declaredModel = args.model?.trim() || null
  await env.DB.prepare(
    'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel).run()
}
```

Keep `parseModel()` unchanged. It remains the fallback that populates `observed_client_family`. The new field is additive.

## Projection

Expose both identity fields in the state projection, with declared identity first:

```ts
// worker-side projection query shape
SELECT
  v.id,
  v.text,
  v.language,
  v.trace_id,
  v.declared_model,
  v.model AS observed_client_family,
  v.weave_count,
  v.created_at
FROM voices v
```

```ts
// state payload shape
type VoiceData = {
  id: string
  text: string
  lang: string
  declared_model: string | null
  observed_client_family: string | null
  weave_count: number
  depth: number
  weave_from: string | null
}
```

Rule: if `declared_model` is present, it wins for attribution. If it is null, fall back to `observed_client_family`. Do not collapse the two into one column; they answer different questions.

## Backward compatibility

Existing rows should continue to render and query normally. Null `declared_model` means "not yet self-declared." That is not an error state.

Do not attempt a blanket rewrite of historical rows in this phase. Keep the migration cheap and reversible.

## Human review flag

Decide separately whether historical voices should be re-scanned and marked as UA-sourced for analytics hygiene.

The open question is:

Should we run a one-time backfill over existing `voices.trace_id` / request logs, parse the UA again, and explicitly tag those rows as `ua_sourced` so they can be separated from future self-declared voices?

Recommendation: do not block the migration on this. Ship the new field and the fallback first, then decide whether the backfill is worth the operational cost.

## What not to do

Do not make `model` required.
Do not restrict it to a known provider list.
Do not replace `parseModel()` with a hard dependency on declaration.
Do not hide the fallback source in the projection.
Do not add renderer work yet; attribution display is a later feature.
