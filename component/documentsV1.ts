/**
 * component/documentsV1.ts — additive DOCUMENTS layer (VP task
 * k170e3tygkh99a83kj3b72xbed8cf5cf), calqued directly on chunksV1.ts's
 * pattern: same requireOrgScope guard, same upsert-by-index strategy, same
 * paged-count strategy as 0.4.1's countChunks fix.
 *
 * Purely ADDITIVE: this file does not import from or modify chunksV1.ts.
 * insertChunks / countChunks / searchCorpus are untouched by this addition.
 *
 * A DOCUMENT is the whole-source entity (e.g. one court ruling). `chunks`
 * rows may optionally carry a `document_id` (see component/schema.ts) to
 * link a passage-chunk back to its parent document for a future
 * fine-grained RAG layer — that linking is NOT enforced here; this file
 * only owns the `documents` table's CRUD-lite surface.
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";

// Structured refusal payloads — mirrors chunksV1's contract 1:1 (Pi +
// operator finding: a plain Error thrown with a bare string reaches every
// Convex client as an opaque "Server Error" + a request id; only `ConvexError`
// carries its payload across the client boundary).
const documentInputValidator = v.object({
	document_id: v.string(),
	text: v.string(),
	title: v.optional(v.string()),
	source_ref: v.optional(v.string()),
	legal_references: v.optional(v.array(v.string())),
});

function requireOrgScope(orgId: string, scope: string): void {
	if (!orgId) {
		throw new ConvexError({
			code: "org_required" as const,
			orgId,
			scope,
			message:
				"orgId is required — deny by default, refusing an unscoped documents write/read.",
		});
	}
	if (!scope) {
		throw new ConvexError({
			code: "scope_required" as const,
			orgId,
			scope,
			message:
				"scope is required — deny by default, refusing an unscoped documents write/read.",
		});
	}
}

// incrementDocumentScopeCount — write-time counter maintenance for
// `document_scope_counts`. Mirrors chunksV1's incrementChunkScopeCount 1:1:
// get-then-patch via `by_org_scope`, called ONLY from the genuine-insert
// branch so idempotency lives at the call site.
//
// By the time this runs, `ensureDocumentScopeMeasuredForWrite` (below) has
// ALREADY run at the top of insertDocuments and guarantees a "ready"
// counter row exists — the `row === null` create-branch that used to live
// here is now DEAD on the insertDocuments path. A missing row here is a
// loud, defensive throw rather than a silent re-creation.
async function incrementDocumentScopeCount(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
): Promise<void> {
	const row = await ctx.db
		.query("document_scope_counts")
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
				"increment: counter row missing — ensureDocumentScopeMeasuredForWrite must run first",
		});
	}
	await ctx.db.patch(row._id, { count: row.count + 1 });
}

// ensureDocumentScopeMeasuredForWrite — mirrors chunksV1's
// ensureScopeMeasuredForWrite 1:1 (REPLACES the earlier
// requireDocumentsNotBootstrapping guard, it subsumes it). Closes the
// subtler defect Eta caught in REVISE round 2 on dac3f49: `row === null` at
// the top of a write is AMBIGUOUS between "a fresh scope, born under this
// code" and "a historical scope with pre-existing rows never bootstrapped."
// One O(1) `.take(1)` on the DATA table separates the two meanings, run
// BEFORE any insert this call makes: empty ⇒ the scope genuinely begins
// here, create the counter row ready-0; non-empty ⇒ historical unmeasured
// scope, create the counter row "bootstrapping" and REFUSE this write.
async function ensureDocumentScopeMeasuredForWrite(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
	opName: string,
): Promise<void> {
	const row = await ctx.db
		.query("document_scope_counts")
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
		.query("documents")
		.withIndex("by_org_scope_document", (q) =>
			q.eq("orgId", orgId).eq("scope", scope),
		)
		.take(1);

	if (existingPage.length === 0) {
		// Genuinely begins here — authoritative from row zero.
		await ctx.db.insert("document_scope_counts", {
			org_id: orgId,
			scope,
			count: 0,
			status: "ready",
			bootstrap_cursor: "",
		});
		return;
	}

	// Historical unmeasured scope — refuse the write outright. As in
	// chunksV1's mirror, the `ctx.db.insert` below documents intent but a
	// Convex mutation is transactional: throwing after it rolls the whole
	// handler back, so nothing persists — the throw is the real guard, and
	// the scope stays UNMEASURED (no row) until bootstrapDocumentScopeCount
	// creates it.
	await ctx.db.insert("document_scope_counts", {
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
		message: `${opName}: org=${orgId} scope=${scope} has pre-existing unmeasured rows — run bootstrapDocumentScopeCount first`,
	});
}

// decrementDocumentScopeCount — never below 0; a missing counter row is
// treated as already-0 (no-op), never an error.
async function decrementDocumentScopeCount(
	ctx: MutationCtx,
	orgId: string,
	scope: string,
): Promise<void> {
	const row = await ctx.db
		.query("document_scope_counts")
		.withIndex("by_org_scope", (q) =>
			q.eq("org_id", orgId).eq("scope", scope),
		)
		.unique();
	if (row === null) return;
	await ctx.db.patch(row._id, { count: Math.max(0, row.count - 1) });
}

// insertDocuments — UPSERTS N documents of the common schema under
// (orgId, scope), keyed by document_id. Idempotence lives HERE, at the data
// layer: re-ingesting the same document_id under the same (orgId, scope)
// PATCHES the existing row in place — it never inserts a second row. The
// lookup goes through the `by_org_scope_document` index (["orgId","scope",
// "document_id"], isolation fields first, deny by default) — never a scan
// across orgId/scope. Same pattern as chunksV1.insertChunks.
//
// Return-count semantics: the returned number counts documents PROCESSED
// (inserted + updated), not insert-only — matches insertChunks's contract.
export const insertDocuments = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		documents: v.array(documentInputValidator),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		await ensureDocumentScopeMeasuredForWrite(ctx, args.orgId, args.scope, "insertDocuments");
		const now = Date.now();
		for (const document of args.documents) {
			const existing = await ctx.db
				.query("documents")
				.withIndex("by_org_scope_document", (q) =>
					q
						.eq("orgId", args.orgId)
						.eq("scope", args.scope)
						.eq("document_id", document.document_id),
				)
				.unique();

			if (existing !== null) {
				await ctx.db.patch(existing._id, {
					text: document.text,
					title: document.title,
					source_ref: document.source_ref,
					legal_references: document.legal_references,
				});
			} else {
				await ctx.db.insert("documents", {
					orgId: args.orgId,
					scope: args.scope,
					document_id: document.document_id,
					text: document.text,
					title: document.title,
					source_ref: document.source_ref,
					legal_references: document.legal_references,
					createdAt: now,
				});
				// Genuine-insert branch ONLY — the `existing !== null` branch
				// above (re-upsert) never reaches here, so the counter is
				// idempotent on repeat ingestion of the same document_id.
				await incrementDocumentScopeCount(ctx, args.orgId, args.scope);
			}
		}
		return args.documents.length;
	},
});

const documentResultValidator = v.object({
	document_id: v.string(),
	text: v.string(),
	title: v.optional(v.string()),
	source_ref: v.optional(v.string()),
	legal_references: v.optional(v.array(v.string())),
	scope: v.string(),
});

// getDocument — point lookup by (orgId, scope, document_id) via the
// `by_org_scope_document` index (isolation fields first, deny by default).
// Returns null when the row does not exist OR belongs to a different
// (orgId, scope) — same isolation guarantee as chunksV1.searchCorpus.
export const getDocument = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
		document_id: v.string(),
	},
	returns: v.union(documentResultValidator, v.null()),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const row = await ctx.db
			.query("documents")
			.withIndex("by_org_scope_document", (q) =>
				q
					.eq("orgId", args.orgId)
					.eq("scope", args.scope)
					.eq("document_id", args.document_id),
			)
			.unique();

		if (row === null) return null;

		return {
			document_id: row.document_id,
			text: row.text,
			title: row.title,
			source_ref: row.source_ref,
			legal_references: row.legal_references,
			scope: row.scope,
		};
	},
});

// deleteDocument — removes a single document row by (orgId, scope,
// document_id) via the `by_org_scope_document` index (isolation fields
// first, deny by default). Decrements `document_scope_counts` ONLY when a
// row actually existed and was deleted — deleting an already-absent
// document_id is a no-op for both the table and the counter. No delete
// mutation existed on this table prior to this change (insertDocuments was
// upsert-only); this is the first write path that removes a documents row,
// and the only decrement call site.
export const deleteDocument = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		document_id: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		await ensureDocumentScopeMeasuredForWrite(ctx, args.orgId, args.scope, "deleteDocument");
		const existing = await ctx.db
			.query("documents")
			.withIndex("by_org_scope_document", (q) =>
				q
					.eq("orgId", args.orgId)
					.eq("scope", args.scope)
					.eq("document_id", args.document_id),
			)
			.unique();
		if (existing === null) return false;
		await ctx.db.delete(existing._id);
		await decrementDocumentScopeCount(ctx, args.orgId, args.scope);
		return true;
	},
});

// countDocuments — the EXACT number of `documents` rows for (orgId, scope),
// READ FROM THE WRITE-TIME COUNTER (`document_scope_counts`), NEVER a scan
// of the `documents` table itself.
//
// A Convex COMPONENT forbids `.paginate()` outright — "paginate() is only
// supported in the app" — raised on every scope, empty or not (measured by
// Talos on prod proficient-rabbit-316 and dev dashing-ermine-394; call sites
// confirmed by Pi). This rebuild removes ALL scanning from the count path:
// `insertDocuments` (genuine-insert branch only) and `deleteDocument`
// maintain `document_scope_counts` at write time, and this reads that
// single counter row via the `by_org_scope` index — one indexed point
// lookup, O(1) regardless of corpus size, no `.paginate()`, no
// `.collect()`, no `.take()`-loop.
//
// REFUSAL, not a silent 0 (Eta REVISE, PR #11 @616e8197, mirrored from
// chunksV1.countChunks): a scope with NO counter row is UNMEASURED, not
// empty. countDocuments returns a number ONLY for a row whose `status` is
// "ready" — seeded live (authoritative from row zero) or fully walked by
// `bootstrapDocumentScopeCount`. Every other state throws.
export const countDocuments = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);

		const row = await ctx.db
			.query("document_scope_counts")
			.withIndex("by_org_scope", (q) =>
				q.eq("org_id", args.orgId).eq("scope", args.scope),
			)
			.unique();

		if (row === null) {
			throw new ConvexError({
				code: "scope_not_initialized" as const,
				orgId: args.orgId,
				scope: args.scope,
				message: `countDocuments: scope not initialized for org=${args.orgId} scope=${args.scope} — refusing to return 0 on an unmeasured scope; run bootstrapDocumentScopeCount first`,
			});
		}
		if (row.status !== "ready") {
			throw new ConvexError({
				code: "scope_bootstrap_in_progress" as const,
				orgId: args.orgId,
				scope: args.scope,
				message: `countDocuments: bootstrap in progress for org=${args.orgId} scope=${args.scope} — count not yet authoritative`,
			});
		}
		return row.count;
	},
});

// bootstrapDocumentScopeCount — mirrors chunksV1.bootstrapScopeCount 1:1 for
// the `documents` table, walking via `by_org_scope_document` and advancing
// the cursor on `document_id`. Same no-`.paginate()`, no-unbounded-
// `.collect()`, resumable, idempotent-per-page contract.
//
// TAKE(k)-BOUNDED, NOT a JS-side byte budget (0.4.7 correction of a false
// fix shipped in 0.4.6 — measured firsthand by the coordinator on a real
// dev deployment: 25 counter-less rows of ~700 KB each, imported directly
// via `npx convex import`, then bootstrapScopeCount still threw
// `Uncaught Error: Too many bytes read in a single function execution
// (limit: 16777216 bytes)`, same class as chunksV1.bootstrapScopeCount). A
// JS-side `break` over a `for await` iterator does NOT bound the bytes the
// Convex runtime reads — the iterator PREFETCHES storage ahead of JS
// consumption, so accumulating `bytesSoFar` and breaking once it crosses a
// budget only stops the LOOP, never the underlying read the runtime
// already issued. Only `.take(k)` bounds the runtime read to exactly k
// documents. With Convex's 1 MiB max document size, `.take(k)` for k ≤ 15
// is ALWAYS safe regardless of document size — `k=8` (the default below)
// reads at most ~8 MiB in one execution, always under the 16 MiB
// per-execution read limit. `pageSize` stays overridable upward for a
// caller who KNOWS its documents are small (the throughput lever); the
// default is the safety floor.
//
// Quiescence during bootstrap is ENFORCED (coordinator DELTA 2/4, mirrors
// chunksV1): insertDocuments/deleteDocument both refuse a write to a
// "bootstrapping" scope via `ensureDocumentScopeMeasuredForWrite`, which
// also disambiguates `row === null` between "born here" and "historical
// unmeasured scope" via a single `.take(1)` on the data table.
const SAFE_DEFAULT_PAGE = 8; // .take(8) <= ~8 MiB at Convex's 1 MiB/doc cap — always under the 16MiB read limit.

export const bootstrapDocumentScopeCount = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		// Bounded page size, read via `.take()` — the ONLY construct that
		// limits what the Convex runtime actually reads in one execution.
		// Default SAFE_DEFAULT_PAGE=8; override upward only if the scope's
		// documents are known to be small (throughput lever, not a safety
		// knob to raise blindly).
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
		const k = args.pageSize ?? SAFE_DEFAULT_PAGE;

		let row = await ctx.db
			.query("document_scope_counts")
			.withIndex("by_org_scope", (q) =>
				q.eq("org_id", args.orgId).eq("scope", args.scope),
			)
			.unique();

		if (row === null) {
			const insertedId = await ctx.db.insert("document_scope_counts", {
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
					message: "bootstrapDocumentScopeCount: failed to read back inserted counter row",
				});
			}
		}

		// Idempotent no-op — a ready scope is never re-bootstrapped.
		if (row.status === "ready") {
			return { done: true, processed: 0, total: row.count, cursor: "" };
		}

		const cursor = row.bootstrap_cursor ?? "";
		const page = await ctx.db
			.query("documents")
			.withIndex("by_org_scope_document", (q) =>
				q
					.eq("orgId", args.orgId)
					.eq("scope", args.scope)
					.gt("document_id", cursor),
			)
			.take(k);

		if (page.length === 0) {
			// An empty page means the scope was walked and genuinely holds
			// nothing — ready-0 here is a MEASURED zero, semantically
			// distinct from the unmeasured-scope throw in countDocuments;
			// bootstrap is the deliberate measurement act that earns it.
			await ctx.db.patch(row._id, { status: "ready" });
			return { done: true, processed: 0, total: row.count, cursor };
		}

		const newTotal = row.count + page.length;
		const newCursor = page[page.length - 1].document_id;
		await ctx.db.patch(row._id, { count: newTotal, bootstrap_cursor: newCursor });
		return { done: false, processed: page.length, total: newTotal, cursor: newCursor };
	},
});
