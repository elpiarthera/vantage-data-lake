/**
 * component/chunksV1.ts — Convergence KB chunk namespace (VP task
 * k170j3b94dpfwxmrm2qxtwm5p18bqqjm, T2, mission convergence). data-lake
 * absorbs @vantageos/corpus's distinct value: documentary chunks, (orgId,
 * scope) isolation, native Convex BM25 search — ZERO embeddings, ZERO
 * external API call. Mirrors corpus's `insertChunks` / `searchCorpus`
 * contract 1:1 so BU consumers (Thémis droit-du-travail, Talos corpus) can
 * migrate off @vantageos/corpus without a data-shape change.
 *
 * This is a THIRD, independent isolation axis alongside `memoriesV1`'s
 * `namespace` field and kb's `team/<orgId>/<docId>` convention — orgId and
 * scope are caller-supplied (never `ctx.auth`), same rationale as
 * memoriesV1/episodesV1: a Convex Component has no ambient auth context, so
 * isolation is enforced entirely by the argument-validation layer plus the
 * index shape (orgId first in every index — deny by default).
 *
 * BM25-only, NO embeddings: this path never calls an embedding model or the
 * AI Gateway — it runs entirely inside the deployment's own native
 * full-text index, for domains without a semantic-search budget. The
 * existing vector/hybrid path in searchV1.ts is untouched by this addition.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const chunkInputValidator = v.object({
	chunkId: v.string(),
	text: v.string(),
	sectionTitle: v.optional(v.string()),
	legalReferences: v.array(v.string()),
	sourceRef: v.string(),
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

// upsert — UPSERTS N chunks of the common schema under (orgId, scope), keyed
// by chunkId. Idempotence lives HERE, at the data layer: re-ingesting the
// same chunkId under the same (orgId, scope) PATCHES the existing row in
// place — it never inserts a second row. The lookup goes through the
// `by_org_scope_chunkid` index (["orgId","scope","chunkId"], isolation
// fields first, deny by default) — never a scan across orgId/scope. A
// chunkId collision across a DIFFERENT scope or orgId is a distinct row:
// the upsert never crosses that boundary.
//
// Return-count semantics: the returned number counts chunks PROCESSED
// (inserted + updated), not insert-only — a full re-run of an unchanged
// corpus reports the same total as the first run.
export const upsert = mutation({
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
				.withIndex("by_org_scope_chunkid", (q) =>
					q
						.eq("orgId", args.orgId)
						.eq("scope", args.scope)
						.eq("chunkId", chunk.chunkId),
				)
				.unique();

			if (existing !== null) {
				await ctx.db.patch(existing._id, {
					text: chunk.text,
					sectionTitle: chunk.sectionTitle,
					legalReferences: chunk.legalReferences,
					sourceRef: chunk.sourceRef,
				});
			} else {
				await ctx.db.insert("chunks", {
					orgId: args.orgId,
					scope: args.scope,
					chunkId: chunk.chunkId,
					text: chunk.text,
					sectionTitle: chunk.sectionTitle,
					legalReferences: chunk.legalReferences,
					sourceRef: chunk.sourceRef,
					createdAt: now,
				});
			}
		}
		return args.chunks.length;
	},
});

const chunkResultValidator = v.object({
	chunkId: v.string(),
	text: v.string(),
	sectionTitle: v.optional(v.string()),
	legalReferences: v.array(v.string()),
	sourceRef: v.string(),
	scope: v.string(),
});

// search — native BM25 full-text search over `text`, FILTERED to (orgId,
// scope) INSIDE the searchIndex query itself (`.withSearchIndex`'s own
// `.eq(...)` filter chain) — never a post-read filter over an unscoped
// scan. A query in scope A can never observe a scope-B chunk: the search
// index's own filterFields boundary is the isolation guard.
//
// BM25-only, NO embeddings: this path never calls an embedding model or the
// AI Gateway — it runs entirely inside the deployment's own native
// full-text index, for domains without a semantic-search budget (mirrors
// corpus's zero-embedding design; the existing hybrid/vector path in
// searchV1.ts is untouched by this addition).
export const search = query({
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
			chunkId: r.chunkId,
			text: r.text,
			sectionTitle: r.sectionTitle,
			legalReferences: r.legalReferences,
			sourceRef: r.sourceRef,
			scope: r.scope,
		}));
	},
});
