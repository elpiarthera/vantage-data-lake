// component/loadChunks.ts — reusable batched loader: takes already-normalized
// chunks (contract shape, see normalizeSourceChunk.ts) and replays them into
// `chunksV1.insertChunks` (component/chunksV1.ts) in batches of BATCH_SIZE,
// so a domain ingestion worker calls ONE committed function instead of
// hand-rolling its own batching loop. Zero domain knowledge here — this
// module knows nothing about legi/kali/fiches or any other domain, only the
// contract shape and the batching mechanics.
//
// Ported from vantage-memory's convex/loadChunks.ts (VP task
// k170j3b94dpfwxmrm2qxtwm5p18bqqjm, T2 — data-lake chunk namespace), logic
// unchanged. T3 (k170v3p0sxty10jv8ba9vg45x18bpbeq) reconciled the contract
// shape to @vantageos/corpus's snake_case (chunk_id not chunkId) — this
// module is untyped to the specific keys (generic over `NormalizedChunk`),
// so no logic changed here, only these comments.
//
// A Convex mutation has a payload-size ceiling; batching keeps each
// `chunksV1.insertChunks` call well under it regardless of corpus size
// (corpus's T-C1 proved 87292 chunks load fine at this batch size).

import type { NormalizedChunk } from "./normalizeSourceChunk.js";

export const DEFAULT_BATCH_SIZE = 500;

// The subset of the Convex `ctx`/client this loader needs: something that
// can run the `chunksV1.upsert` mutation. Kept minimal and untyped to the
// Convex runtime so this module stays testable with a plain mock — no
// `convex-test` harness required to exercise the batching logic itself.
export type InsertChunksFn = (args: {
	orgId: string;
	scope: string;
	chunks: NormalizedChunk[];
}) => Promise<number>;

export type LoadChunksResult = {
	totalChunks: number;
	batches: number;
	inserted: number;
};

// loadChunksBatched — splits `chunks` into batches of `batchSize` (default
// 500) and calls `upsertChunks` once per batch, sequentially (never
// concurrent — chunksV1.upsert batches share the same (orgId, scope) target
// and sequential calls keep the ingestion order deterministic and replay
// re-runnable). Returns the total inserted count, derived from the sum of
// each batch's own return value — never assumed equal to `chunks.length`.
export async function loadChunksBatched(
	upsertChunks: InsertChunksFn,
	args: {
		orgId: string;
		scope: string;
		chunks: NormalizedChunk[];
		batchSize?: number;
	},
): Promise<LoadChunksResult> {
	const { orgId, scope, chunks, batchSize = DEFAULT_BATCH_SIZE } = args;
	if (!orgId) {
		throw new Error(
			"loadChunksBatched: orgId is required — deny by default, refusing an unscoped load.",
		);
	}
	if (!scope) {
		throw new Error(
			"loadChunksBatched: scope is required — deny by default, refusing an unscoped load.",
		);
	}
	if (batchSize <= 0) {
		throw new Error(`loadChunksBatched: batchSize must be > 0, got ${batchSize}.`);
	}

	let inserted = 0;
	let batches = 0;
	for (let i = 0; i < chunks.length; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize);
		const count = await upsertChunks({ orgId, scope, chunks: batch });
		inserted += count;
		batches += 1;
	}

	return { totalChunks: chunks.length, batches, inserted };
}
