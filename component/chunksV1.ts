/**
 * component/chunksV1.ts — Convergence KB chunk namespace, absorbing
 * @vantageos/corpus's public contract 1:1 (VP task
 * k170v3p0sxty10jv8ba9vg45x18bpbeq, T3; ported from T2's
 * k170j3b94dpfwxmrm2qxtwm5p18bqqjm which first added this table under a
 * camelCase convention — T3 reconciles it to corpus's snake_case shape so
 * the wire contract is byte-identical).
 *
 * Exports `insertChunks` / `searchCorpus` with the EXACT argument and
 * result shape of @vantageos/corpus's component/corpus.ts (snake_case:
 * chunk_id, section_title, legal_references, source_ref). This is a THIRD,
 * independent isolation axis alongside `memoriesV1`'s `namespace` field and
 * kb's `team/<orgId>/<docId>` convention — orgId and scope are
 * caller-supplied (never `ctx.auth`), same rationale as
 * memoriesV1/episodesV1: a Convex Component has no ambient auth context, so
 * isolation is enforced entirely by the argument-validation layer plus the
 * index shape (orgId first in every index — deny by default).
 *
 * BM25-only, NO embeddings: this path never calls an embedding model or the
 * AI Gateway — it runs entirely inside the deployment's own native
 * full-text index, for domains without a semantic-search budget. The
 * existing vector/hybrid path in searchV1.ts is untouched by this addition.
 *
 * NOTE on wire-path parity: Talos's ingestion worker calls the Convex HTTP
 * API at the bare path `corpus:insertChunks` (vantage-corpus-worker's
 * src/corpus_client.py, INSERT_CHUNKS_PATH). A Convex Component's exports
 * are namespaced under the host app's `components.dataLake.chunksV1.*` and
 * are NOT directly reachable at a bare `corpus:insertChunks` HTTP path —
 * only a top-level `convex/corpus.ts` file in the HOST app that mounts this
 * component can re-expose these two functions at that exact path. That
 * host-app wiring is outside this package's scope (this repo ships the
 * Component only, no top-level convex/ app) and is a follow-up for
 * whichever deployment Talos/Thémis will repoint CONVEX_URL to.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";

const chunkInputValidator = v.object({
	chunk_id: v.string(),
	text: v.string(),
	section_title: v.optional(v.string()),
	legal_references: v.array(v.string()),
	source_ref: v.string(),
});

function requireOrgScope(orgId: string, scope: string): void {
	if (!orgId) {
		throw new Error(
			"orgId is required — deny by default, refusing an unscoped chunks write/read.",
		);
	}
	if (!scope) {
		throw new Error(
			"scope is required — deny by default, refusing an unscoped chunks write/read.",
		);
	}
}

// incrementChunkScopeCount / decrementChunkScopeCount — write-time counter
// maintenance for `chunk_scope_counts`. Get-then-patch via the
// `by_org_scope` index (isolation fields first). Called ONLY from the
// genuine-insert branch (never the update/upsert branch) so a re-upsert of
// an existing chunk_id never moves the counter — idempotency lives at the
// call site (insertChunks' existing new-vs-existing branch), not here.
async function incrementChunkScopeCount(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
): Promise<void> {
	const row = await ctx.db
		.query("chunk_scope_counts")
		.withIndex("by_org_scope", (q) =>
			q.eq("org_id", orgId).eq("scope", scope),
		)
		.unique();
	if (row === null) {
		await ctx.db.insert("chunk_scope_counts", {
			org_id: orgId,
			scope,
			count: 1,
		});
	} else {
		await ctx.db.patch(row._id, { count: row.count + 1 });
	}
}

// decrementChunkScopeCount — never below 0; a missing counter row is treated
// as already-0 (no-op), never an error.
async function decrementChunkScopeCount(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
): Promise<void> {
	const row = await ctx.db
		.query("chunk_scope_counts")
		.withIndex("by_org_scope", (q) =>
			q.eq("org_id", orgId).eq("scope", scope),
		)
		.unique();
	if (row === null) return;
	await ctx.db.patch(row._id, { count: Math.max(0, row.count - 1) });
}

// insertChunks — UPSERTS N chunks of the common schema under (orgId, scope),
// keyed by chunk_id. Idempotence lives HERE, at the data layer: re-ingesting
// the same chunk_id under the same (orgId, scope) PATCHES the existing row
// in place — it never inserts a second row. The lookup goes through the
// `by_org_scope_chunk` index (["orgId","scope","chunk_id"], isolation
// fields first, deny by default) — never a scan across orgId/scope. A
// chunk_id collision across a DIFFERENT scope or orgId is a distinct row:
// the upsert never crosses that boundary.
//
// Return-count semantics: the returned number counts chunks PROCESSED
// (inserted + updated), not insert-only — a full re-run of an unchanged
// corpus reports the same total as the first run. Matches
// @vantageos/corpus's `insertChunks` contract byte-for-byte.
export const insertChunks = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		chunks: v.array(chunkInputValidator),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const now = Date.now();
		for (const chunk of args.chunks) {
			const existing = await ctx.db
				.query("chunks")
				.withIndex("by_org_scope_chunk", (q) =>
					q
						.eq("orgId", args.orgId)
						.eq("scope", args.scope)
						.eq("chunk_id", chunk.chunk_id),
				)
				.unique();

			if (existing !== null) {
				await ctx.db.patch(existing._id, {
					text: chunk.text,
					section_title: chunk.section_title,
					legal_references: chunk.legal_references,
					source_ref: chunk.source_ref,
				});
			} else {
				await ctx.db.insert("chunks", {
					orgId: args.orgId,
					scope: args.scope,
					chunk_id: chunk.chunk_id,
					text: chunk.text,
					section_title: chunk.section_title,
					legal_references: chunk.legal_references,
					source_ref: chunk.source_ref,
					createdAt: now,
				});
				// Genuine-insert branch ONLY — a re-upsert (the `existing !==
				// null` branch above) never reaches here, so the counter is
				// idempotent on repeat ingestion of the same chunk_id.
				await incrementChunkScopeCount(ctx, args.orgId, args.scope);
			}
		}
		return args.chunks.length;
	},
});

// deleteChunk — removes a single chunk row by (orgId, scope, chunk_id) via
// the `by_org_scope_chunk` index (isolation fields first, deny by default).
// Decrements `chunk_scope_counts` ONLY when a row actually existed and was
// deleted — deleting an already-absent chunk_id is a no-op for both the
// table and the counter. No delete mutation existed on this table prior to
// this change (insertChunks was upsert-only); this is the first write path
// that removes a chunks row, so it is also the first (and only) decrement
// call site.
export const deleteChunk = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		chunk_id: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const existing = await ctx.db
			.query("chunks")
			.withIndex("by_org_scope_chunk", (q) =>
				q
					.eq("orgId", args.orgId)
					.eq("scope", args.scope)
					.eq("chunk_id", args.chunk_id),
			)
			.unique();
		if (existing === null) return false;
		await ctx.db.delete(existing._id);
		await decrementChunkScopeCount(ctx, args.orgId, args.scope);
		return true;
	},
});

const chunkResultValidator = v.object({
	chunk_id: v.string(),
	text: v.string(),
	section_title: v.optional(v.string()),
	legal_references: v.array(v.string()),
	source_ref: v.string(),
	scope: v.string(),
});

// searchCorpus — native BM25 full-text search over `text`, FILTERED to
// (orgId, scope) INSIDE the searchIndex query itself (`.withSearchIndex`'s
// own `.eq(...)` filter chain) — never a post-read filter over an unscoped
// scan. A query in scope A can never observe a scope-B chunk: the search
// index's own filterFields boundary is the isolation guard.
//
// BM25-only, NO embeddings: this path never calls an embedding model or the
// AI Gateway — it runs entirely inside the deployment's own native
// full-text index, for domains without a semantic-search budget (mirrors
// corpus's zero-embedding design; the existing hybrid/vector path in
// searchV1.ts is untouched by this addition). Matches @vantageos/corpus's
// `searchCorpus` contract byte-for-byte.
export const searchCorpus = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
		query: v.string(),
		limit: v.optional(v.number()),
	},
	returns: v.array(chunkResultValidator),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const q = args.query.trim();
		if (q === "") return [];
		const limit = args.limit ?? 10;

		const rows = await ctx.db
			.query("chunks")
			.withSearchIndex("search_text", (sq) =>
				sq.search("text", q).eq("orgId", args.orgId).eq("scope", args.scope),
			)
			.take(limit);

		return rows.map((r) => ({
			chunk_id: r.chunk_id,
			text: r.text,
			section_title: r.section_title,
			legal_references: r.legal_references,
			source_ref: r.source_ref,
			scope: r.scope,
		}));
	},
});

// countChunks — the EXACT number of `chunks` rows for (orgId, scope), READ
// FROM THE WRITE-TIME COUNTER (`chunk_scope_counts`), NEVER a scan of the
// `chunks` table itself.
//
// A Convex COMPONENT forbids `.paginate()` outright — "paginate() is only
// supported in the app" — raised on every scope, empty or not (measured by
// Talos on prod proficient-rabbit-316 and dev dashing-ermine-394; call sites
// confirmed by Pi). The prior 0.4.1 fix paged around `.collect()`'s ~16MB
// cap but still called `.paginate()`, which the component runtime rejects
// unconditionally — the 32/32 green suite was a FALSE green because
// convex-test permits `.paginate()` where the component runtime forbids it.
//
// This rebuild removes ALL scanning from the count path: `insertChunks`
// (genuine-insert branch only) and `deleteChunk` maintain
// `chunk_scope_counts` at write time, and this reads that single counter
// row via the `by_org_scope` index — one indexed point lookup, O(1)
// regardless of corpus size, no `.paginate()`, no `.collect()`, no
// `.take()`-loop.
export const countChunks = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);

		const row = await ctx.db
			.query("chunk_scope_counts")
			.withIndex("by_org_scope", (q) =>
				q.eq("org_id", args.orgId).eq("scope", args.scope),
			)
			.unique();
		return row === null ? 0 : row.count;
	},
});
