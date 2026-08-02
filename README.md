# @vantageos/data-lake

Convex Component: RAG + embeddings + intake générique substrate for
VantagePeers, Vantage Radar, Vantage Immo, and downstream BUs.

## Install

```bash
pnpm add @vantageos/data-lake
```

## Mount

In your consumer's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import dataLake from "@vantageos/data-lake/convex.config.js";

const app = defineApp();
app.use(dataLake, { name: "dataLake" });        // VantagePeers
// or
app.use(dataLake, { name: "radarDataLake" });    // Vantage Radar (isolated namespace)
export default app;
```

The same Component can be mounted multiple times under distinct names in
different deployments — each mount gets its own isolated tables and RAG
namespace.

## Public API

### Write path — `memoriesV1.storeMemory` + `episodesV1.storeEpisode` (v0.3.0+, BREAKING)

Both mutations REQUIRE `embedding: number[]` at runtime. The validator types
it as optional for forward compatibility, but the handler throws a clear
error if omitted (loud failure > silent inconsistency — Day 79 doctrine).
Indexing is inline in RAG (chunks-form, no embedding compute inside the
Component — consistent with ADR Phase E.0 "no use node in Components").

```ts
// Host computes embedding via its own aiClient (Node-side OK in host)
const embedding = await aiClient.embed(content);

await ctx.runMutation(
  components.<mountName>.component.memoriesV1.storeMemory,
  { content, namespace, type, createdBy, embedding },
);
```

Calling `storeMemory` / `storeEpisode` WITHOUT `embedding` throws :
`embedding required — host must compute via aiClient.embed before storeMemory call. See ADR Phase E.0 + README contract.`

Supersede / softDelete / TTL-expire paths re-use the stored `embedding`
field on the memory row (added to the Component schema in v0.2.3) — no
host recompute needed for those operations.

### `hybridSearchV1` (v0.2.2+)

**Access path:** `components.<mountName>.component.<file>.<export>` — the
`.component.` intermediate is required because `convex.config.ts` lives at
the package root while function modules live in `component/*.ts`. Convex
codegen nests modules under a `component` key in this layout. Example:
`components.radarDataLake.component.searchV1.hybridSearchV1`.

(If you compared with `@convex-dev/rag` which has no `.component.` wrapper:
that package colocates its `convex.config.ts` inside the same directory as
its function files, so codegen flattens. Different layout, different path.)


Hybrid search (vector + BM25 RRF fusion) over the data lake namespace.

```ts
const res = await ctx.runAction(
  components.dataLake.component.searchV1.hybridSearchV1,
  {
    query: "the search text",
    queryEmbedding: await aiClient.embed("the search text"),  // host-computed
    namespace: "global",
    type: "user",            // optional, generic string
    onlyLatest: true,        // default true
    limit: 10,
    vectorWeight: 1,
    textWeight: 1,
    vectorScoreThreshold: 0.15,
    minRrfRank: undefined,
    extraFilters: [{ name: "bu", value: "vantage-immo" }],    // optional
  },
);
// → { results: [{id, rrfScore, content, metadata}], totalMatches, latencyMs }
```

**`queryEmbedding` is required.** The Component cannot compute embeddings
itself (Convex CLI 1.39.1 forbids `"use node"` in Components — ADR Phase
E.0). Compute it host-side via your own `aiClient.ts` action and pass the
`Array<number>` here.

### Other actions

| Action | Purpose |
|---|---|
| `memoriesV1.store` | Insert / supersede a memory with optional embedding |
| `memoriesV1.validateIds` | Validate cross-Component memory id references |
| `episodesV1.storeEpisode` | Store an episode tied to memories |
| `searchV1.recall` | Pure vector search (semantic) |
| `searchV1.textSearch` | Pure BM25 text search |
| `searchV1.hybridSearch` | Legacy hybrid action (v0.1.0 signature, kept for VP host) |
| `searchV1.searchFixPatterns` | Hydrated vector search over the `fixpatterns` namespace |
| `chunksV1.insertChunks` | Upsert N documentary chunks under `(orgId, scope)`, keyed by `chunk_id` — no embedding required |
| `chunksV1.searchCorpus` | BM25-only full-text search over chunks, scoped to `(orgId, scope)` — zero embeddings |

### `chunksV1` — BM25-only chunk namespace (zero embeddings), absorbs `@vantageos/corpus` 1:1

Documentary chunk storage isolated by caller-supplied `(orgId, scope)` —
same "no `ctx.auth`" rationale as `memoriesV1`/`episodesV1`. No embedding
or AI Gateway call is ever made by this path; search runs entirely inside
Convex's native full-text index.

`insertChunks` / `searchCorpus` are the EXACT function names, argument
shape, and result shape (snake_case: `chunk_id`, `section_title`,
`legal_references`, `source_ref`) as `@vantageos/corpus`'s public contract
— see "Deprecating `@vantageos/corpus`" below.

```ts
await ctx.runMutation(components.dataLake.component.chunksV1.insertChunks, {
  orgId: "org-a",
  scope: "droit-du-travail",
  chunks: [
    {
      chunk_id: "chunk-1",
      text: "Le contrat de travail à durée indéterminée...",
      section_title: "Article L1221-1",
      legal_references: ["Code du travail L1221-1"],
      source_ref: "https://legifrance.gouv.fr/L1221-1",
    },
  ],
});

const results = await ctx.runQuery(components.dataLake.component.chunksV1.searchCorpus, {
  orgId: "org-a",
  scope: "droit-du-travail",
  query: "période d'essai",
  limit: 10,
});
```

## Deprecating `@vantageos/corpus`

`@vantageos/corpus` is ABSORBED into this component's `chunksV1` namespace
(`insertChunks` / `searchCorpus`, byte-identical contract). New consumers
should target `@vantageos/data-lake`'s `chunksV1` namespace directly.
Existing consumers (Thémis droit-du-travail, Talos's
`vantage-corpus-worker` ingestion worker) migrate by repointing their
`CONVEX_URL` to a deployment that mounts this component AND re-exposes
`insertChunks`/`searchCorpus` at the top-level `corpus:insertChunks` /
`corpus:searchCorpus` HTTP paths their client code already calls — that
host-app wiring is a separate, deployment-specific follow-up (this package
ships the Component only).

The prepared deprecation command for whoever runs T4 (publish-side; NOT
run as part of this change):

```bash
npm deprecate @vantageos/corpus@">=0.0.0" "Deprecated: absorbed into @vantageos/data-lake's chunksV1 namespace (insertChunks/searchCorpus, byte-identical contract). See https://github.com/vantageos-agency/vantage-peers/tree/main/packages/data-lake#deprecating-vantageoscorpus"
```

## References

- API surface conventions: [`decisions/c1-namespacing-convention-2026-05-21.md`](../../decisions/c1-namespacing-convention-2026-05-21.md)
- Public APIs design: [`decisions/c1-public-apis-design-2026-05-21.md`](../../decisions/c1-public-apis-design-2026-05-21.md)
- Embedding host-responsibility ADR: [`decisions/c1-phase-e0-component-api-internal-change-2026-05-21.md`](../../decisions/c1-phase-e0-component-api-internal-change-2026-05-21.md)
- `hybridSearchV1` contract: co-designed with xi (msg `jn77yys9t4vjxcqc9v8x2j8xqd879bx9`), Day 79 round 2 review of Vantage Radar v2.

## License

FSL-1.1-Apache-2.0 — see `LICENSE` at repo root.
