import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
	creatorValidator,
	severityValidator,
	relationTypeValidator,
} from "./schema";
import { rag } from "./searchV1";

// ─────────────────────────────────────────────────────────────────────────────
// storeEpisode
// Creates a memory with type="episode" + full episode metadata.
// Episodic memory is the "other half" Mem0 doesn't solve:
//   - context + goal + action + outcome = what happened (episodic)
//   - insight = what was learned (procedural)
//
// v0.3.0 BREAKING: host MUST pass pre-computed `embedding`. Fail-fast at the
// boundary if omitted — replaces v0.2.x silent skip that produced
// embeddings=0 bug. RAG indexing is inline via
// `rag.add({ chunks: [{ text, embedding }] })` — no scheduler, no Node.
// ─────────────────────────────────────────────────────────────────────────────

export const storeEpisode = mutation({
	args: {
		namespace: v.string(),
		createdBy: creatorValidator,
		context: v.string(),
		goal: v.string(),
		action: v.string(),
		outcome: v.string(),
		insight: v.string(),
		severity: severityValidator,
		relations: v.optional(
			v.array(
				v.object({
					targetId: v.id("memories"),
					type: relationTypeValidator,
				}),
			),
		),
		ttl: v.optional(v.string()),
		// Pre-computed embedding from host. REQUIRED at runtime (v0.3.0+) —
		// validator stays optional for forward compatibility but the handler
		// throws if undefined.
		embedding: v.optional(v.array(v.float64())),
	},
	returns: v.id("memories"),
	handler: async (ctx, args) => {
		if (args.embedding === undefined) {
			throw new Error(
				"embedding required — host must compute via aiClient.embed before storeEpisode call. See ADR Phase E.0 + README contract.",
			);
		}

		const now = Date.now();

		const content = [
			`Context: ${args.context}`,
			`Goal: ${args.goal}`,
			`Action: ${args.action}`,
			`Outcome: ${args.outcome}`,
			`Insight: ${args.insight}`,
		].join(" | ");

		const memoryId = await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: "episode",
			content,
			createdBy: args.createdBy,
			relations: args.relations ?? [],
			isLatest: true,
			ttl: args.ttl,
			episode: {
				context: args.context,
				goal: args.goal,
				action: args.action,
				outcome: args.outcome,
				insight: args.insight,
				severity: args.severity,
			},
			embedding: args.embedding,
			createdAt: now,
			updatedAt: now,
		});

		await rag.add(ctx, {
			namespace: args.namespace,
			key: String(memoryId),
			title: content.substring(0, 100),
			filterValues: [
				{ name: "namespace", value: args.namespace },
				{ name: "type", value: "episode" },
				{ name: "isLatest", value: "true" },
			],
			metadata: {
				namespace: args.namespace,
				type: "episode",
				memoryId: String(memoryId),
			},
			chunks: [
				{
					text: content,
					embedding: args.embedding,
				},
			],
		});

		return memoryId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listEpisodes — list episodes for a namespace, ordered newest first
// ─────────────────────────────────────────────────────────────────────────────

export const listEpisodes = query({
	args: {
		namespace: v.string(),
		severity: v.optional(severityValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("memories"),
			_creationTime: v.number(),
			namespace: v.string(),
			createdBy: creatorValidator,
			content: v.string(),
			isLatest: v.boolean(),
			createdAt: v.number(),
			episode: v.object({
				context: v.string(),
				goal: v.string(),
				action: v.string(),
				outcome: v.string(),
				insight: v.string(),
				severity: severityValidator,
			}),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		const episodes = await ctx.db
			.query("memories")
			.withIndex("by_namespace_type", (q) =>
				q
					.eq("namespace", args.namespace)
					.eq("type", "episode")
					.eq("isLatest", true),
			)
			.order("desc")
			.collect();

		const filtered =
			args.severity !== undefined
				? episodes.filter((e) => e.episode?.severity === args.severity)
				: episodes;

		return filtered
			.filter((e) => e.episode !== undefined)
			.slice(0, limit)
			.map((e) => ({
				_id: e._id,
				_creationTime: e._creationTime,
				namespace: e.namespace,
				createdBy: e.createdBy,
				content: e.content,
				isLatest: e.isLatest,
				createdAt: e.createdAt,
				episode: e.episode!,
			}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getCriticalInsights — returns all critical-severity episodes across namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const getCriticalInsights = query({
	args: { limit: v.optional(v.number()) },
	returns: v.array(
		v.object({
			_id: v.id("memories"),
			namespace: v.string(),
			createdBy: creatorValidator,
			insight: v.string(),
			context: v.string(),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 30;

		const episodes = await ctx.db
			.query("memories")
			.withIndex("by_type", (q) =>
				q.eq("type", "episode").eq("isLatest", true),
			)
			.order("desc")
			.collect();

		return episodes
			.filter((e) => e.episode?.severity === "critical")
			.slice(0, limit)
			.map((e) => ({
				_id: e._id,
				namespace: e.namespace,
				createdBy: e.createdBy,
				insight: e.episode!.insight,
				context: e.episode!.context,
				createdAt: e.createdAt,
			}));
	},
});
