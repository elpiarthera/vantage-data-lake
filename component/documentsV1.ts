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

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const documentInputValidator = v.object({
	document_id: v.string(),
	text: v.string(),
	title: v.optional(v.string()),
	source_ref: v.optional(v.string()),
	legal_references: v.optional(v.array(v.string())),
});

function requireOrgScope(orgId: string, scope: string): void {
	if (!orgId) {
		throw new Error(
			"orgId is required — deny by default, refusing an unscoped documents write/read.",
		);
	}
	if (!scope) {
		throw new Error(
			"scope is required — deny by default, refusing an unscoped documents write/read.",
		);
	}
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

// countDocuments — the EXACT number of `documents` rows for (orgId, scope),
// READ FROM THE DATABASE, PAGED (same strategy as 0.4.1's countChunks fix —
// VP task k171tdmy8xwx8ss0yckae0pdbn8cfxad): a single `.collect()` raises
// "Too many bytes read in a single function execution" past ~16MB and never
// truncates. This reads bounded pages via `by_org_scope_document` and
// accumulates a running scalar — no single function execution ever reads
// more than one page's worth of bytes regardless of scope size.
const COUNT_DOCUMENTS_PAGE_SIZE = 500;

export const countDocuments = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);

		let total = 0;
		let cursor: string | null = null;
		while (true) {
			const page = await ctx.db
				.query("documents")
				.withIndex("by_org_scope_document", (q) =>
					q.eq("orgId", args.orgId).eq("scope", args.scope),
				)
				.paginate({ cursor, numItems: COUNT_DOCUMENTS_PAGE_SIZE });
			total += page.page.length;
			if (page.isDone) {
				break;
			}
			cursor = page.continueCursor;
		}
		return total;
	},
});
