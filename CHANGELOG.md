# @vantageos/data-lake — Changelog

## 0.3.1 — 2026-05-24 (Day 80) — patch : `scripts/` excluded from tarball

**Bug fix** : `scripts/verify-tarball.mjs` (the anti-recurrence
prepublishOnly hook added in 0.3.0) was shipped at package root in the
0.3.0 tarball. Convex bundler on the consumer side picked it as an
isolate entry point and refused to boot — the file uses `node:fs`,
`node:path`, `node:url` without a `"use node"` directive.

Discovered by beta during Vantage Radar 0.3.0 migration (msg
`jn75y35fc8mxs9nkfdj1z4ns5h87bxx4`). Worked around locally via `bun
patch` deleting the file from the installed package — that workaround is
no longer needed in 0.3.1.

**Fix** : drop `scripts/verify-tarball.mjs` from the `files` whitelist
in `package.json`. The script stays in the source tree for the
prepublishOnly hook (which runs locally before pack, so it still gates
publish), but is no longer included in the published tarball.

**Meta-doctrine note** : the hook added to prevent bug #4 (ragSync.ts
missing from tarball) created bug #5 (extra file in tarball that Convex
bundler can't handle). Layer-2 lesson : a guard hook needs its own
guard — the `files` whitelist is now the second hook that constrains
the first. "Memory is not enough" → "hook is required" → "hooks need
their own scope-guards".

**Impact** :
- vantage-radar (beta) — can drop the bun patch workaround on next bump.
- vantage-immo (xi) — would have inherited the bug at next bump; now safe.
- Future consumers — clean tarball, no extraneous root-level files.

No API change. No schema change. Drop-in 0.3.0 → 0.3.1.

## 0.3.0 — 2026-05-23 (Day 79) — BREAKING + RAG WRITE-PATH FIX

**BREAKING for consumers : `storeMemory` and `storeEpisode` now THROW when
called without `embedding`.** The validator still types `embedding` as
optional (forward-compat / static-tooling friendly) but the handler
fail-fasts at the boundary with a clear error message :

> `embedding required — host must compute via aiClient.embed before storeMemory call. See ADR Phase E.0 + README contract.`

**Why a loud error instead of silent skip** : v0.2.0/0.2.1/0.2.2 silently
dropped RAG indexing when embedding was missing → embeddings=0 in
production until beta caught the gap during Vantage Radar smoke. Doctrine
D79 : evidence-bound, loud failure > silent inconsistency.

**Why a major-version bump (semver clean signal to consumers)** : the
behavioral requirement on `embedding` is a contract change. Existing
callers that omit `embedding` will start throwing where they previously
no-op'd. Bumping minor would obscure that signal.

**RAG WRITE-PATH FIX (carried over from the 0.2.3 candidate)** :

- `storeMemory` + `storeEpisode` index entries inline via
  `rag.add(ctx, { chunks: [{ text, embedding }] })` — chunks-form, no
  embedding compute inside the Component, no `"use node"`.
- Schema `memories` table gets `embedding: v.optional(v.array(v.float64()))`
  so supersede / softDelete / TTL-expire paths re-index from stored
  embedding without recomputing.
- All `ctx.scheduler.runAfter(0, internal.ragSync.*)` calls removed.
  `ragSync.ts` was never shipped in any tarball and is no longer needed.

**Tarball verification hook** : `scripts/verify-tarball.ts` runs at
`prepublishOnly` time to parse `internal.<file>.<action>` references in
the Component sources and verify each referenced `<file>.ts` is included
in the package `files` glob. Future-proof against the gap that caused
bug #3 (missing `ragSync.ts` referenced but never shipped, 0.2.0→0.2.2).

**Migration for consumers** :
1. `pnpm add @vantageos/data-lake@0.3.0`
2. Wrap every `storeMemory` / `storeEpisode` call site with `aiClient.embed(content)`.
3. Pass the resulting `Array<number>` as the new `embedding` arg.
4. Drop any host-side workarounds for the missing-RAG-indexing bug.

**Impact** :
- vantage-radar (beta) — must update 1 site (storeMemory call) — embed pipeline functional immediately after.
- vantage-immo (xi) — no call sites yet, no migration.
- vantage-memory host (sigma) — Phase D.3 not executed, no call sites yet.

## 0.2.3 — UNRELEASED (superseded by 0.3.0)

Initial clean-refactor candidate. Eta APPROVED clean (msg
`jn708emc589h2db9qzaw3tx1wh8788n6`, task k174x9emmq8f66q44ekz50zbas878nt1).
Pi arbitrage Day 79 (msg `jn7fvqv4xd54s5f7pc3thpm6x58793vz`) then
elevated the contract to loud fail-fast + major-version bump for clean
semver signal. See 0.3.0 entry above.

## 0.2.3 (deprecated heading below — historical record only)

## 0.2.3 — 2026-05-23 (Day 79) — RAG WRITE-PATH FIX (clean refactor)

**Critical fix: RAG indexing on write paths.** Discovered by beta (msg
`jn771nwv037dm604e0dcyfwxsn878krf`) while wiring `embedAllExistingSources`
on Vantage Radar : `memoriesV1.storeMemory` + `episodesV1.storeEpisode`
scheduled `internal.ragSync.{addRagEntry,markRagEntrySuperseded}` but the
`ragSync.ts` module was never shipped in the Component package, AND
Convex Components cannot use `"use node"` (ADR Phase E.0, commit
`067e26a` Day 77) — so we cannot embed text host-blind inside the
Component.

**Refactor (architectural, aligned with E.0 ADR "host wrap responsibility"):**

- `memoriesV1.storeMemory` now accepts optional `embedding: v.array(v.float64())`.
- `episodesV1.storeEpisode` same.
- When `embedding` is provided, the mutation indexes the entry inline via
  `rag.add(ctx, { chunks: [{ text, embedding }] })` (chunks-form, no
  embedding compute, no `"use node"`).
- `ragSync.ts` is removed entirely from the Component — it was never
  shipped and is no longer needed.
- All `ctx.scheduler.runAfter(0, internal.ragSync.*)` calls deleted.
- New schema field on `memories`: `embedding: v.optional(v.array(v.float64()))`
  so supersede / softDelete / TTL-expire paths can re-index from stored
  embedding without recomputing.

**Host responsibility (caller contract):**

```ts
// Host computes embedding via aiClient (Node-side OK in host)
const embedding = await aiClient.embed(content);

// Pass to Component mutation
await ctx.runMutation(
  components.<mountName>.component.memoriesV1.storeMemory,
  { content, namespace, type, createdBy, embedding },
);
```

Without `embedding`, the memory is stored but **not indexed in RAG** —
`searchV1.recall` / `hybridSearchV1` will not return it.

**Backwards-compatibility:**
- `embedding` is optional, so existing callers compile unchanged. They lose
  RAG indexing silently — same as 0.2.2's broken behavior — but no
  ArgumentValidationError.
- The `embedding` schema field is `v.optional`, so existing rows do not
  require migration.

**Impact:**
- vantage-radar (beta) — embed pipeline functional once host wrapper adds `embedding` arg.
- vantage-immo (xi) — no impact yet (no consumer call sites).
- vantage-memory host (sigma) — no impact yet (Phase D.3 not executed).

## 0.2.2 — 2026-05-23 (Day 79) — RUNTIME FIX (revised)

**Two critical fixes for downstream consumers (beta findings on Vantage Radar smoke).**

### Fix 1: `convex.config.ts` declares its rag dependency

The published 0.2.0/0.2.1 `convex.config.ts` was missing
`component.use(rag)`, so `searchV1.ts`'s use of `components.rag.search.search`
failed to resolve at runtime in any host. Convex Component isolation
requires each child Component to declare its own sub-component deps —
declaring `app.use(rag)` in the host does not propagate to nested
Components. Fixed by adding `component.use(rag)` to the package's
`convex.config.ts`.

### Fix 2: `_generated/api.ts` now ships as a runtime shim instead of
type-only declarations

Bug discovered by beta (msg `jn7bedx365htctqwt3etd8w37h8793fg`) while wiring
Vantage Radar v2 RAG against this Component. The published 0.2.0/0.2.1
tarballs shipped `_generated/api.ts` as `export declare const api: {...}` —
type-only declarations that Convex bundler cannot resolve at runtime.
Consumers got `Child component does not export [searchV1, hybridSearchV1]`.

Fix:
```ts
// Before (broken at runtime)
export declare const api: { fixPatterns: FixPatternsApi };
export declare const internal: { ragSync: RagSyncInternal };
export declare const components: Record<string, any>;

// After (0.2.2 — runtime shim)
import { anyApi, componentsGeneric } from "convex/server";
export const api: any = anyApi;
export const internal: any = anyApi;
export const components: any = componentsGeneric();
```

Pattern matches `@convex-dev/rag`'s published `_generated/api.ts` (canonical
Convex Component reference).

Impact :
- Vantage Radar Phase 1 RAG (beta) — unblocks `components.radarDataLake.searchV1.hybridSearchV1` runtime
- Vantage Immo F7/F8 (xi) — latent, no consumer call sites yet
- VantagePeers host (sigma) — unaffected so far (no consumer call sites in `convex/`, Phase D.3 not executed)

No API signature change. Consumers can upgrade `0.2.1 → 0.2.2` with no code modification.

## 0.2.1 — 2026-05-23 (Day 79)

**Patch: `hybridSearchV1` metadata.isLatest typed as `v.boolean()`** — Pi
arbitrage (msg jn744jr73582kwt8tjajyhnt21879c5m) on the xi↔sigma residual Q1
from the v0.2.0 contract review.

Rationale: pure boolean semantics (`true | false`), no stringification
ambiguity (`"true"` string vs `true` bool in Convex queries), no risk of
accidental string comparison in downstream consumer filters.

Internal: handler converts the RAG filter value `"true"` / `"false"` string
(@convex-dev/rag constraint — filter values are strings only) to a real
boolean at output time. The internal filter storage convention is unchanged.

Non-breaking for v0.2.0 consumers: only the output `metadata.isLatest` type
changes from `string` to `boolean`. Anyone who shipped against v0.2.0 should
adjust their type signature to `boolean` and remove any `=== "true"` checks.

## 0.2.0 — 2026-05-23 (Day 79)

**New public API: `hybridSearchV1`** — additive, non-breaking.

Promotes the existing `hybridSearch` (vector + BM25 RRF fusion) to a formal
public API designed for cross-host consumption. Contract co-designed with xi
in round 2 of the Vantage Radar v2 review (msg jn77yys9, task k172g0c5).

### Contract

```ts
hybridSearchV1({
  query: string,
  queryEmbedding: number[],             // REQUIRED — host-computed (E.0 ADR)
  namespace?: string,
  type?: string,                         // generic string, not memoryTypeValidator
  onlyLatest?: boolean,                  // default true
  extraFilters?: Array<{name, value}>,   // downstream filter slot (rag.filterNames at boot)
  limit?: number,                        // default 10
  vectorWeight?: number,                 // default 1
  textWeight?: number,                   // default 1
  vectorScoreThreshold?: number,         // default 0.15 — vector half cutoff pre-RRF
  minRrfRank?: number,                   // optional cutoff on RRF rank post-merge
}) → {
  results: Array<{
    id: string,
    rrfScore: number,                    // ∈ [0, 1] position-based per hybridRank
    content: string,
    metadata: { namespace, type, isLatest },  // isLatest as "true"/"false" string
  }>,
  totalMatches: number,                  // pre-cutoff union size
  latencyMs: number,
}
```

### Why the queryEmbedding is required

Inherited from the ADR Phase E.0 (Day 77, commit 6b79220): Convex CLI 1.39.1
rejects `"use node"` directives inside Convex Component packages. The
Component cannot compute embeddings itself — the host (VP, radar, Vantage
Immo, etc.) computes the embedding via its own `aiClient.ts` action and
passes it as a pre-computed `Array<number>`.

### Backwards compatibility

The original `hybridSearch` action (v0.1.0) remains exported with its
original signature. Existing consumers (VP host) continue to work unchanged.
`hybridSearchV1` is the recommended API for new integrations.

### Sellable to downstream BUs

- **Vantage Radar v2** Phase 1 RAG (briefing js7aj13s, Day 79): mounted as
  `radarDataLake`, queries radar-scraped corpus via this contract.
- **Vantage Immo F7/F8** briefing/reporting RAG (xi).
- **Future BUs**: generic substrate, no VP-specific assumptions in args/output.

## 0.1.0 — 2026-05-21 (Day 77)

Initial public release.

- Convex Component scaffold (`defineComponent("dataLake")`).
- `memories` table + validators (memoryTypeValidator, creatorValidator,
  relationTypeValidator, severityValidator) co-located in
  `component/schema.ts`.
- Actions: `memoriesV1.store`, `memoriesV1.validateIds`,
  `episodesV1.storeEpisode`, `searchV1.recall`, `searchV1.textSearch`,
  `searchV1.hybridSearch`, `searchV1.searchFixPatterns`.
- Embedding computation is host-side per E.0 ADR (no `"use node"` in
  Components). All search actions accept pre-computed `queryEmbedding`.
- Host `convex/` unchanged (D.2 zero-regression verified, vitest 295/295).
- Published as `@vantageos/data-lake@0.1.0` (scope rename from `@vantage`).
