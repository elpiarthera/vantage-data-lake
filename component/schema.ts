import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (mirrored from host convex/schema.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const memoryTypeValidator = v.union(
	v.literal("user"),
	v.literal("feedback"),
	v.literal("project"),
	v.literal("reference"),
	v.literal("episode"),
);

// Open validator — any orchestrator name is accepted.
export const creatorValidator = v.string();

export const relationTypeValidator = v.union(
	v.literal("updates"),
	v.literal("extends"),
	v.literal("derives"),
);

export const severityValidator = v.union(
	v.literal("critical"),
	v.literal("major"),
	v.literal("minor"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Component schema — memories + episodes tables
// (byte-for-byte mirror of host convex/schema.ts memories definition)
// ─────────────────────────────────────────────────────────────────────────────

export default defineSchema({
	// ── memories ────────────────────────────────────────────────────────────────
	// Core memory store. Each row is one typed memory entry.
	// Supermemory pattern: updates/extends/derives relations + isLatest flag.
	// Mem0 pattern: typed memory (user/feedback/project/reference/episode).
	// Episodic type includes structured episode metadata.
	//
	// Embedding + search is handled by @convex-dev/rag (component-owned schema).
	// RAG entry key = memoryId string. Filters: namespace, type, isLatest.
	memories: defineTable({
		// Namespace: "global" | "orchestrator/pi" | "project/vantage-starter"
		namespace: v.string(),

		// Memory classification — drives retrieval strategy
		type: memoryTypeValidator,

		// Human-readable content (what the memory says)
		content: v.string(),

		// Which orchestrator (or system) created this memory
		createdBy: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this

		// Graph relations to other memories (Supermemory pattern)
		// "updates" supersedes target (sets target.isLatest = false)
		// "extends" adds detail to target (both remain latest)
		// "derives" is an inference drawn from target
		relations: v.array(
			v.object({
				targetId: v.id("memories"),
				type: relationTypeValidator,
			}),
		),

		// True = this is the current authoritative version.
		// False = superseded by a newer "updates" relation.
		// Search always filters isLatest=true by default.
		isLatest: v.boolean(),

		// Optional TTL hint (ISO string). Cron job handles actual expiry.
		// Example: "2026-06-01T00:00:00Z"
		ttl: v.optional(v.string()),

		// Episodic memory payload — only present when type="episode"
		episode: v.optional(
			v.object({
				context: v.string(), // Situation that triggered this episode
				goal: v.string(), // What was being attempted
				action: v.string(), // What was actually done
				outcome: v.string(), // What happened
				insight: v.string(), // The lesson extracted (procedural memory)
				severity: severityValidator,
			}),
		),

		// Optional pre-computed embedding from host (v0.2.3+).
		// Host computes via aiClient and passes to storeMemory. Stored so
		// that supersede / softDelete paths can re-index without recomputing
		// (Components cannot use "use node", so embedding compute is host-only).
		embedding: v.optional(v.array(v.float64())),

		// Timestamp (ms since epoch)
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Primary query patterns — all filtered to isLatest for active memory reads
		.index("by_namespace", ["namespace", "isLatest"])
		.index("by_type", ["type", "isLatest"])
		.index("by_creator", ["createdBy", "isLatest"])
		.index("by_namespace_type", ["namespace", "type", "isLatest"]),

	// ── chunks ──────────────────────────────────────────────────────────────────
	// Convergence KB namespace (VP task k170j3b94dpfwxmrm2qxtwm5p18bqqjm T2,
	// absorbed 1:1 from @vantageos/corpus in k170v3p0sxty10jv8ba9vg45x18bpbeq
	// T3). Documentary chunk storage: (orgId, scope) isolation, native Convex
	// BM25 full-text search — ZERO embeddings, ZERO external API call.
	//
	// Field names, table shape, and index names are BYTE-IDENTICAL to
	// @vantageos/corpus's component/schema.ts (snake_case: chunk_id,
	// section_title, legal_references, source_ref) so BU consumers (Thémis
	// droit-du-travail, Talos corpus ingestion worker) can migrate off
	// @vantageos/corpus by repointing CONVEX_URL alone, once the host app
	// mounts this component and re-exposes `insertChunks` / `searchCorpus` at
	// the deployment's top level — zero data-shape translation needed.
	//
	// This is a THIRD, independent isolation axis alongside `memories.namespace`
	// and kb's `team/<orgId>/<docId>` convention — orgId + scope is
	// caller-supplied (never `ctx.auth`), deny by default: orgId is the FIRST
	// field of every index, so a query with no orgId cannot resolve an index.
	chunks: defineTable({
		orgId: v.string(),
		scope: v.string(),
		chunk_id: v.string(),
		text: v.string(),
		section_title: v.optional(v.string()),
		legal_references: v.array(v.string()),
		source_ref: v.string(),
		createdAt: v.number(),
		// Optional link to a parent `documents` row (see below). Added
		// additively (VP task k170e3tygkh99a83kj3b72xbed8cf5cf) — every
		// existing chunk row (no document_id) stays valid, and
		// insertChunks/countChunks/searchCorpus are untouched by this field.
		document_id: v.optional(v.string()),
	})
		// Row listing / test assertions scoped to (orgId, scope).
		.index("by_org_scope", ["orgId", "scope"])
		// Upsert + point lookup by (orgId, scope, chunk_id) — deny by default,
		// isolation fields first. Name matches corpus's index 1:1.
		.index("by_org_scope_chunk", ["orgId", "scope", "chunk_id"])
		// BM25 full-text search on `text`, filtered inside the search index
		// itself by (orgId, scope) — NO vector/embedding index on this table.
		.searchIndex("search_text", {
			searchField: "text",
			filterFields: ["orgId", "scope"],
		}),

	// ── documents ───────────────────────────────────────────────────────────────
	// Additive documents layer (VP task k170e3tygkh99a83kj3b72xbed8cf5cf).
	// A DOCUMENT is the whole-source entity (e.g. one court ruling); `chunks`
	// rows may optionally point back to a document via `document_id` for a
	// future fine-grained RAG passage layer. This table does NOT replace or
	// modify `chunks` — a consumer may keep storing 1 document = 1 chunk, or
	// adopt documents + passage-chunks, both remain valid simultaneously.
	//
	// Same isolation axis and conventions as `chunks`: (orgId, scope)
	// caller-supplied (never `ctx.auth`), deny by default via requireOrgScope,
	// orgId first in every index.
	documents: defineTable({
		orgId: v.string(),
		scope: v.string(),
		document_id: v.string(),
		text: v.string(),
		title: v.optional(v.string()),
		source_ref: v.optional(v.string()),
		legal_references: v.optional(v.array(v.string())),
		createdAt: v.number(),
	})
		// Row listing / test assertions scoped to (orgId, scope).
		.index("by_org_scope", ["orgId", "scope"])
		// Upsert + point lookup by (orgId, scope, document_id) — deny by
		// default, isolation fields first. Mirrors chunks' by_org_scope_chunk.
		.index("by_org_scope_document", ["orgId", "scope", "document_id"]),
});
