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

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";

// Structured refusal payloads (Pi + operator finding, follow-up to REVISE
// rounds 1-2): a plain Error thrown with a bare string reaches every Convex
// client as an opaque "Server Error" + a request id — ONLY `ConvexError`
// carries its payload across the client boundary. Every consumer-reachable
// refusal below throws `ConvexError({ code, orgId, scope, message })` so a
// caller reads organisation, scope and cause AS DATA and can switch on
// `error.data.code` — in particular distinguishing "never seeded"
// (scope_not_initialized) from "seeding in progress"
// (scope_bootstrap_in_progress), which a message-only Error left as two
// indistinguishable strings at the client.
const chunkInputValidator = v.object({
	chunk_id: v.string(),
	text: v.string(),
	section_title: v.optional(v.string()),
	legal_references: v.array(v.string()),
	source_ref: v.string(),
});

function requireOrgScope(orgId: string, scope: string): void {
	if (!orgId) {
		throw new ConvexError({
			code: "org_required" as const,
			orgId,
			scope,
			message:
				"orgId is required — deny by default, refusing an unscoped chunks write/read.",
		});
	}
	if (!scope) {
		throw new ConvexError({
			code: "scope_required" as const,
			orgId,
			scope,
			message:
				"scope is required — deny by default, refusing an unscoped chunks write/read.",
		});
	}
}

// incrementChunkScopeCount — write-time counter maintenance for
// `chunk_scope_counts`. Get-then-patch via the `by_org_scope` index
// (isolation fields first). Called ONLY from the genuine-insert branch
// (never the update/upsert branch) so a re-upsert of an existing chunk_id
// never moves the counter — idempotency lives at the call site
// (insertChunks' existing new-vs-existing branch), not here.
//
// By the time this runs, `ensureScopeMeasuredForWrite` (below) has ALREADY
// run at the top of insertChunks and guarantees a "ready" counter row
// exists for (orgId, scope) — so the `row === null` create-branch that used
// to live here is now DEAD on the insertChunks path and would only fire on
// a genuine bug (a call site that skipped the guard). Rather than silently
// re-creating a "ready" row in that case — which is exactly the false-
// measured-integer defect this round of REVISE closes — a missing row here
// is a loud, defensive throw.
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
		throw new ConvexError({
			code: "internal_invariant" as const,
			orgId,
			scope,
			message:
				"increment: counter row missing — ensureScopeMeasuredForWrite must run first",
		});
	}
	await ctx.db.patch(row._id, { count: row.count + 1 });
}

// ensureScopeMeasuredForWrite — REPLACES the earlier requireNotBootstrapping
// guard (it subsumes it) and closes a subtler defect Eta caught in REVISE
// round 2 on dac3f49: `row === null` at the top of a write is AMBIGUOUS — it
// means EITHER "a fresh scope, born under this code, with zero history" OR
// "a historical scope with pre-existing rows that were never bootstrapped."
// Stamping the former's answer (status:"ready") onto the latter produces a
// false measured integer (e.g. countChunks = 1 for a scope that actually
// holds 10001 rows) that is WORSE than the visible 0 this whole fix started
// from, because bootstrapScopeCount then treats "ready" as its own
// idempotent no-op and never runs.
//
// One O(1) `.take(1)` on the DATA table separates the two meanings, run
// BEFORE any insert this call makes: empty ⇒ the scope genuinely begins
// here, create the counter row ready-0 (the normal genuine-insert path then
// increments it to N); non-empty ⇒ historical unmeasured scope, create the
// counter row "bootstrapping" and REFUSE this write outright — the loader
// of a historical scope is stopped at its first write instead of poisoning
// the counter, and is told to run bootstrapScopeCount first.
async function ensureScopeMeasuredForWrite(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
	opName: string,
): Promise<void> {
	const row = await ctx.db
		.query("chunk_scope_counts")
		.withIndex("by_org_scope", (q) => q.eq("org_id", orgId).eq("scope", scope))
		.unique();

	if (row !== null) {
		if (row.status === "bootstrapping") {
			throw new ConvexError({
				code: "write_refused_bootstrapping" as const,
				orgId,
				scope,
				message: `${opName}: refusing a write to org=${orgId} scope=${scope} while its counter is bootstrapping — retry after bootstrap completes`,
			});
		}
		// status === "ready" — already measured, proceed.
		return;
	}

	// row === null — disambiguate via a single bounded take(1) on the data
	// table, the ONLY question that separates "born here" from
	// "un-bootstrapped history": did this scope already contain rows?
	const existingPage = await ctx.db
		.query("chunks")
		.withIndex("by_org_scope_chunk", (q) =>
			q.eq("orgId", orgId).eq("scope", scope),
		)
		.take(1);

	if (existingPage.length === 0) {
		// Genuinely begins here — authoritative from row zero.
		await ctx.db.insert("chunk_scope_counts", {
			org_id: orgId,
			scope,
			count: 0,
			status: "ready",
			bootstrap_cursor: "",
		});
		return;
	}

	// Historical unmeasured scope — refuse the write outright rather than
	// stamping a false-ready 1. The `ctx.db.insert` below documents intent
	// (a "bootstrapping" marker row) but a Convex mutation is transactional:
	// throwing after it rolls the whole handler back, so nothing persists —
	// the call site's throw is the actual, observable guard, and the scope
	// is left exactly as it was found (no row at all, i.e. still
	// UNMEASURED). `countChunks` keeps throwing "not initialized" until
	// `bootstrapScopeCount` is run, which creates the row itself.
	await ctx.db.insert("chunk_scope_counts", {
		org_id: orgId,
		scope,
		count: 0,
		status: "bootstrapping",
		bootstrap_cursor: "",
	});
	throw new ConvexError({
		code: "scope_has_unmeasured_rows" as const,
		orgId,
		scope,
		message: `${opName}: org=${orgId} scope=${scope} has pre-existing unmeasured rows — run bootstrapScopeCount first`,
	});
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
		await ensureScopeMeasuredForWrite(ctx, args.orgId, args.scope, "insertChunks");
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
		await ensureScopeMeasuredForWrite(ctx, args.orgId, args.scope, "deleteChunk");
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
//
// REFUSAL, not a silent 0 (Eta REVISE, PR #11 @616e8197): a scope with NO
// counter row is UNMEASURED, not empty — 144283 historical rows were
// written before this counter existed, via a path other than insertChunks,
// and never touched `chunk_scope_counts`. Returning 0 for such a scope is
// indistinguishable from a genuinely empty one and is a worse failure mode
// than a crash: it is a confident, silent lie. countChunks now returns a
// number ONLY for a row whose `status` is "ready" — i.e. either seeded by a
// live insert (authoritative from row zero) or fully walked by
// `bootstrapScopeCount`. Every other state throws, naming the fix.
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

		if (row === null) {
			throw new ConvexError({
				code: "scope_not_initialized" as const,
				orgId: args.orgId,
				scope: args.scope,
				message: `countChunks: scope not initialized for org=${args.orgId} scope=${args.scope} — refusing to return 0 on an unmeasured scope; run bootstrapScopeCount first`,
			});
		}
		if (row.status !== "ready") {
			throw new ConvexError({
				code: "scope_bootstrap_in_progress" as const,
				orgId: args.orgId,
				scope: args.scope,
				message: `countChunks: bootstrap in progress for org=${args.orgId} scope=${args.scope} — count not yet authoritative`,
			});
		}
		return row.count;
	},
});

// bootstrapScopeCount — walks the `chunks` table for a historical
// (orgId, scope) pair ONE BOUNDED PAGE AT A TIME via the `by_org_scope_chunk`
// composite index, seeding `chunk_scope_counts` so `countChunks` becomes
// authoritative for rows written before the write-time counter existed.
//
// NO `.paginate()` (illegal in a Convex Component — "paginate() is only
// supported in the app") and NO unbounded `.collect()` (0.4.1 already proved
// it raises past ~16MB). Each call reads `.take(pageSize)` rows strictly
// after `bootstrap_cursor` (exclusive, via `.gt("chunk_id", ...)`), advances
// `count` and `bootstrap_cursor` together in the SAME transaction, and
// returns. The caller loops until `done: true`.
//
// Idempotent per page and safe to re-fire: a repeated call for a row already
// `status:"ready"` is a no-op (returns immediately, never re-walks or
// double-counts); a repeated call mid-walk re-reads from the
// already-advanced cursor, so no row is ever counted twice.
//
// Quiescence during bootstrap is now ENFORCED, not merely documented:
// insertChunks/deleteChunk both refuse a write to a "bootstrapping" scope
// via `ensureScopeMeasuredForWrite` (coordinator DELTA 2/4) — the write-race
// class this comment used to describe as an unenforced precondition no
// longer exists; a caller gets a loud, named throw instead of a silent race.
// The same guard also disambiguates `row === null` (DELTA 4): a scope with
// pre-existing unmeasured rows is stamped "bootstrapping" and its first
// write is refused, rather than being poisoned into a false "ready" 1.
export const bootstrapScopeCount = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		processed: v.number(),
		total: v.number(),
		cursor: v.string(),
	}),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const pageSize = args.pageSize ?? 500;

		let row = await ctx.db
			.query("chunk_scope_counts")
			.withIndex("by_org_scope", (q) =>
				q.eq("org_id", args.orgId).eq("scope", args.scope),
			)
			.unique();

		if (row === null) {
			const insertedId = await ctx.db.insert("chunk_scope_counts", {
				org_id: args.orgId,
				scope: args.scope,
				count: 0,
				status: "bootstrapping",
				bootstrap_cursor: "",
			});
			row = await ctx.db.get(insertedId);
			if (row === null) {
				throw new ConvexError({
					code: "internal_invariant" as const,
					orgId: args.orgId,
					scope: args.scope,
					message: "bootstrapScopeCount: failed to read back inserted counter row",
				});
			}
		}

		// Idempotent no-op — a ready scope is never re-bootstrapped.
		if (row.status === "ready") {
			return { done: true, processed: 0, total: row.count, cursor: "" };
		}

		const cursor = row.bootstrap_cursor ?? "";
		const page = await ctx.db
			.query("chunks")
			.withIndex("by_org_scope_chunk", (q) =>
				q.eq("orgId", args.orgId).eq("scope", args.scope).gt("chunk_id", cursor),
			)
			.take(pageSize);

		if (page.length === 0) {
			// An empty first page means the scope was walked and genuinely
			// holds nothing — ready-0 here is a MEASURED zero, semantically
			// distinct from the unmeasured-scope throw in countChunks;
			// bootstrap is the deliberate measurement act that earns it.
			await ctx.db.patch(row._id, { status: "ready" });
			return { done: true, processed: 0, total: row.count, cursor };
		}

		const newTotal = row.count + page.length;
		const newCursor = page[page.length - 1].chunk_id;
		await ctx.db.patch(row._id, { count: newTotal, bootstrap_cursor: newCursor });
		return { done: false, processed: page.length, total: newTotal, cursor: newCursor };
	},
});
