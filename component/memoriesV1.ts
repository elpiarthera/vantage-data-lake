import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import {
	memoryTypeValidator,
	creatorValidator,
	relationTypeValidator,
	severityValidator,
} from "./schema";
import { rag } from "./searchV1";

// ─────────────────────────────────────────────────────────────────────────────
// Internal RAG helpers (v0.2.3+) — embedding is HOST-computed and passed in.
// Components cannot use "use node" (ADR Phase E.0), so we use the rag.add
// `chunks` form which accepts pre-computed embeddings (no model invocation).
// ─────────────────────────────────────────────────────────────────────────────

async function ragAddInline(
	ctx: Parameters<typeof rag.add>[0],
	args: {
		memoryId: string;
		content: string;
		namespace: string;
		type: string;
		embedding: number[];
		isLatest: boolean;
	},
): Promise<void> {
	await rag.add(ctx, {
		namespace: args.namespace,
		key: args.memoryId,
		title: args.content.substring(0, 100),
		filterValues: [
			{ name: "namespace", value: args.namespace },
			{ name: "type", value: args.type },
			{ name: "isLatest", value: args.isLatest ? "true" : "false" },
		],
		metadata: {
			namespace: args.namespace,
			type: args.type,
			memoryId: args.memoryId,
		},
		chunks: [
			{
				text: args.content,
				embedding: args.embedding,
			},
		],
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// storeMemory
// Creates a memory row and, when host passes an embedding, indexes it into
// @convex-dev/rag inline. Supersede paths re-index from the target's stored
// embedding (no recompute needed).
// ─────────────────────────────────────────────────────────────────────────────

export const storeMemory = mutation({
	args: {
		namespace: v.string(),
		type: memoryTypeValidator,
		content: v.string(),
		createdBy: creatorValidator,
		// Optional: defaults to [] server-side if omitted (fixes #262)
		relations: v.optional(
			v.array(
				v.object({
					targetId: v.id("memories"),
					type: relationTypeValidator,
				}),
			),
		),
		isLatest: v.optional(v.boolean()),
		ttl: v.optional(v.string()),
		episode: v.optional(
			v.object({
				context: v.string(),
				goal: v.string(),
				action: v.string(),
				outcome: v.string(),
				insight: v.string(),
				severity: severityValidator,
			}),
		),
		// Pre-computed embedding from host (v0.2.3+). If omitted, the memory is
		// stored but not indexed in RAG — search will not return it. Host should
		// always provide it for searchable content.
		embedding: v.optional(v.array(v.float64())),
	},
	returns: v.id("memories"),
	handler: async (ctx, args) => {
		// v0.3.0 BREAKING: embedding is behaviorally required. Without it, the
		// memory cannot be indexed in RAG and silently disappears from search —
		// exactly the bug that caused embeddings=0 in v0.2.0/0.2.1/0.2.2. Fail
		// loud at the boundary instead of silently dropping. See E.0 ADR — host
		// is responsible for embedding compute (Components cannot use "use node").
		if (args.embedding === undefined) {
			throw new Error(
				"embedding required — host must compute via aiClient.embed before storeMemory call. See ADR Phase E.0 + README contract.",
			);
		}

		const now = Date.now();
		const relations = args.relations ?? [];

		// 1. Create the memory row
		const memoryId = await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: args.type,
			content: args.content,
			createdBy: args.createdBy,
			relations,
			isLatest: true,
			ttl: args.ttl,
			episode: args.episode,
			embedding: args.embedding,
			createdAt: now,
			updatedAt: now,
		});

		// 2. Handle "updates" relations — supersede target memories.
		// Re-index each target with isLatest="false" so searches filtering
		// isLatest="true" stop returning them. Targets without stored embedding
		// (legacy rows from pre-0.3.0) cannot be re-indexed — skip.
		for (const relation of relations) {
			if (relation.type === "updates") {
				const target = await ctx.db.get(relation.targetId);
				if (target !== null) {
					await ctx.db.patch(relation.targetId, {
						isLatest: false,
						updatedAt: now,
					});

					if (target.embedding !== undefined) {
						await ragAddInline(ctx, {
							memoryId: String(relation.targetId),
							content: target.content,
							namespace: target.namespace,
							type: target.type,
							embedding: target.embedding,
							isLatest: false,
						});
					}
				}
			}
		}

		// 3. Index the new memory in RAG inline (embedding is guaranteed present).
		await ragAddInline(ctx, {
			memoryId: String(memoryId),
			content: args.content,
			namespace: args.namespace,
			type: args.type,
			embedding: args.embedding,
			isLatest: true,
		});

		return memoryId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getMemory — fetch single memory by ID
// ─────────────────────────────────────────────────────────────────────────────

export const getMemory = query({
	args: { memoryId: v.id("memories") },
	returns: v.union(
		v.object({
			_id: v.id("memories"),
			_creationTime: v.number(),
			namespace: v.string(),
			type: memoryTypeValidator,
			content: v.string(),
			createdBy: creatorValidator,
			relations: v.array(
				v.object({
					targetId: v.id("memories"),
					type: relationTypeValidator,
				}),
			),
			isLatest: v.boolean(),
			ttl: v.optional(v.string()),
			episode: v.optional(
				v.object({
					context: v.string(),
					goal: v.string(),
					action: v.string(),
					outcome: v.string(),
					insight: v.string(),
					severity: severityValidator,
				}),
			),
			embedding: v.optional(v.array(v.float64())),
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.memoryId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMemories — list active memories by namespace, with optional type filter
// ─────────────────────────────────────────────────────────────────────────────

const memoryDocValidator = v.object({
	_id: v.id("memories"),
	_creationTime: v.number(),
	namespace: v.string(),
	type: memoryTypeValidator,
	content: v.string(),
	createdBy: creatorValidator,
	relations: v.array(
		v.object({
			targetId: v.id("memories"),
			type: relationTypeValidator,
		}),
	),
	isLatest: v.boolean(),
	ttl: v.optional(v.string()),
	episode: v.optional(
		v.object({
			context: v.string(),
			goal: v.string(),
			action: v.string(),
			outcome: v.string(),
			insight: v.string(),
			severity: severityValidator,
		}),
	),
	embedding: v.optional(v.array(v.float64())),
	createdAt: v.number(),
	updatedAt: v.number(),
});

// Paginated return shape — compat-first: existing callers reading `.value` work unchanged.
const listMemoriesResultValidator = v.object({
	value: v.array(memoryDocValidator),
	continueCursor: v.union(v.string(), v.null()),
	isDone: v.boolean(),
});

export const listMemories = query({
	args: {
		namespace: v.string(),
		type: v.optional(memoryTypeValidator),
		includeSuperseded: v.optional(v.boolean()),
		limit: v.optional(v.number()),
		paginationOpts: v.optional(
			v.object({
				numItems: v.number(),
				cursor: v.union(v.string(), v.null()),
			}),
		),
	},
	returns: listMemoriesResultValidator,
	handler: async (ctx, args) => {
		const isLatest = args.includeSuperseded === true ? undefined : true;
		const numItems = args.paginationOpts?.numItems ?? args.limit ?? 50;
		const cursor = args.paginationOpts?.cursor ?? null;

		if (args.paginationOpts !== undefined) {
			const opts = { numItems, cursor };
			const type = args.type;

			if (type !== undefined && isLatest !== undefined) {
				const r = await ctx.db
					.query("memories")
					.withIndex("by_namespace_type", (q) =>
						q.eq("namespace", args.namespace).eq("type", type).eq("isLatest", true),
					)
					.order("desc")
					.paginate(opts);
				return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
			}

			if (type !== undefined) {
				const r = await ctx.db
					.query("memories")
					.withIndex("by_namespace_type", (q) =>
						q.eq("namespace", args.namespace).eq("type", type),
					)
					.order("desc")
					.paginate(opts);
				return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
			}

			if (isLatest !== undefined) {
				const r = await ctx.db
					.query("memories")
					.withIndex("by_namespace", (q) =>
						q.eq("namespace", args.namespace).eq("isLatest", true),
					)
					.order("desc")
					.paginate(opts);
				return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
			}

			const r = await ctx.db
				.query("memories")
				.withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
				.order("desc")
				.paginate(opts);
			return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
		}

		const limit = numItems;
		const type = args.type;

		if (type !== undefined && isLatest !== undefined) {
			const page = await ctx.db
				.query("memories")
				.withIndex("by_namespace_type", (q) =>
					q.eq("namespace", args.namespace).eq("type", type).eq("isLatest", true),
				)
				.order("desc")
				.take(limit);
			return { value: page, continueCursor: null, isDone: true };
		}

		if (type !== undefined) {
			const page = await ctx.db
				.query("memories")
				.withIndex("by_namespace_type", (q) =>
					q.eq("namespace", args.namespace).eq("type", type),
				)
				.order("desc")
				.take(limit);
			return { value: page, continueCursor: null, isDone: true };
		}

		if (isLatest !== undefined) {
			const page = await ctx.db
				.query("memories")
				.withIndex("by_namespace", (q) =>
					q.eq("namespace", args.namespace).eq("isLatest", true),
				)
				.order("desc")
				.take(limit);
			return { value: page, continueCursor: null, isDone: true };
		}

		const page = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
			.order("desc")
			.take(limit);
		return { value: page, continueCursor: null, isDone: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// softDeleteMemory — marks a memory as no longer latest (audit-preserving).
// Re-indexes the RAG entry with isLatest="false" if an embedding is stored.
// ─────────────────────────────────────────────────────────────────────────────

export const softDeleteMemory = mutation({
	args: { memoryId: v.id("memories") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const memory = await ctx.db.get(args.memoryId);
		if (memory === null) {
			throw new Error(`Memory ${args.memoryId} not found`);
		}

		await ctx.db.patch(args.memoryId, { isLatest: false, updatedAt: Date.now() });

		if (memory.embedding !== undefined) {
			await ragAddInline(ctx, {
				memoryId: String(args.memoryId),
				content: memory.content,
				namespace: memory.namespace,
				type: memory.type,
				embedding: memory.embedding,
				isLatest: false,
			});
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validateIds — boundary query for cross-Component ID validation
// ─────────────────────────────────────────────────────────────────────────────

export const validateIds = query({
	args: {
		ids: v.array(v.string()),
		workspaceId: v.optional(v.string()),
	},
	returns: v.object({
		valid: v.array(v.string()),
		invalid: v.array(v.string()),
		archived: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		if (args.ids.length > 100) {
			throw new Error(`too_many_ids: cap=100, got=${args.ids.length}`);
		}

		const valid: string[] = [];
		const invalid: string[] = [];
		const archived: string[] = [];

		for (const id of args.ids) {
			const typedId = ctx.db.normalizeId("memories", id);
			if (typedId === null) {
				invalid.push(id);
				continue;
			}
			const doc = await ctx.db.get(typedId);
			if (doc === null) {
				invalid.push(id);
			} else if (!doc.isLatest) {
				archived.push(id);
			} else {
				valid.push(id);
			}
		}

		return { valid, invalid, archived };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// expireMemoriesByTtl (internal — called by cron)
// Re-indexes expired memories with isLatest="false" when embedding is stored.
// ─────────────────────────────────────────────────────────────────────────────

export const expireMemoriesByTtl = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const now = new Date().toISOString();
		let expired = 0;

		const candidates = await ctx.db
			.query("memories")
			.filter((q) => q.neq(q.field("ttl"), undefined))
			.take(500);

		for (const memory of candidates) {
			if (memory.ttl !== undefined && memory.ttl < now && memory.isLatest) {
				await ctx.db.patch(memory._id, { isLatest: false, updatedAt: Date.now() });

				if (memory.embedding !== undefined) {
					await ragAddInline(ctx, {
						memoryId: String(memory._id),
						content: memory.content,
						namespace: memory.namespace,
						type: memory.type,
						embedding: memory.embedding,
						isLatest: false,
					});
				}

				expired++;
			}
		}

		return expired;
	},
});
