import { describe, expect, test, vi } from "vitest";
import { DEFAULT_BATCH_SIZE, loadChunksBatched } from "./loadChunks.js";
import type { NormalizedChunk } from "./normalizeSourceChunk.js";

// component/loadChunks.test.ts — ported from vantage-memory's
// convex/loadChunks.test.ts (VP task k170j3b94dpfwxmrm2qxtwm5p18bqqjm, T2),
// reconciled in T3 (k170v3p0sxty10jv8ba9vg45x18bpbeq) onto the snake_case
// `NormalizedChunk` shape (chunk_id, legal_references, source_ref) that now
// matches @vantageos/corpus's insertChunks contract byte-for-byte.
// RED-then-GREEN, pure unit against a mocked upsertChunks (no Convex runtime
// needed to prove the batching mechanics; chunksV1.test.ts already covers
// `insertChunks` itself against the real convex-test harness).
//
// RED (recorded verbatim, captured BEFORE component/loadChunks.ts existed):
//
//   FAIL  component/loadChunks.test.ts [ component/loadChunks.test.ts ]
//   Error: Cannot find module './loadChunks.js' imported from
//   component/loadChunks.test.ts

function makeChunks(n: number): NormalizedChunk[] {
	return Array.from({ length: n }, (_, i) => ({
		chunk_id: `chunk-${i}`,
		text: `text ${i}`,
		legal_references: [],
		source_ref: `src/${i}`,
	}));
}

describe("loadChunksBatched", () => {
	test("MUST_PASS: default batch size is 500", () => {
		expect(DEFAULT_BATCH_SIZE).toBe(500);
	});

	test("MUST_PASS: splits chunks into ceil(n/batchSize) sequential upsertChunks calls", async () => {
		const upsertChunks = vi.fn(async (args: { chunks: NormalizedChunk[] }) => args.chunks.length);
		const chunks = makeChunks(1201);

		const result = await loadChunksBatched(upsertChunks, {
			orgId: "org_a",
			scope: "labor-A",
			chunks,
			batchSize: 500,
		});

		expect(upsertChunks).toHaveBeenCalledTimes(3);
		expect(upsertChunks.mock.calls[0][0].chunks).toHaveLength(500);
		expect(upsertChunks.mock.calls[1][0].chunks).toHaveLength(500);
		expect(upsertChunks.mock.calls[2][0].chunks).toHaveLength(201);
		expect(result).toEqual({ totalChunks: 1201, batches: 3, inserted: 1201 });
	});

	test("MUST_PASS: every batch call carries the same (orgId, scope)", async () => {
		const upsertChunks = vi.fn(
			async (args: { orgId: string; scope: string; chunks: NormalizedChunk[] }) =>
				args.chunks.length,
		);
		await loadChunksBatched(upsertChunks, {
			orgId: "org_x",
			scope: "scope_y",
			chunks: makeChunks(600),
			batchSize: 500,
		});

		for (const call of upsertChunks.mock.calls) {
			expect(call[0].orgId).toBe("org_x");
			expect(call[0].scope).toBe("scope_y");
		}
	});

	test("MUST_PASS: empty chunks array makes zero upsertChunks calls", async () => {
		const upsertChunks = vi.fn(async () => 0);
		const result = await loadChunksBatched(upsertChunks, {
			orgId: "org_a",
			scope: "labor-A",
			chunks: [],
		});
		expect(upsertChunks).not.toHaveBeenCalled();
		expect(result).toEqual({ totalChunks: 0, batches: 0, inserted: 0 });
	});

	test("MUST_PASS: inserted total is derived from upsertChunks' own returned counts, not assumed", async () => {
		// A batch that (hypothetically) dedupes and inserts fewer rows than
		// it received must be reflected honestly in the aggregate.
		const upsertChunks = vi.fn(async (args: { chunks: NormalizedChunk[] }) =>
			args.chunks.length - 1,
		);
		const result = await loadChunksBatched(upsertChunks, {
			orgId: "org_a",
			scope: "labor-A",
			chunks: makeChunks(500),
			batchSize: 500,
		});
		expect(result.inserted).toBe(499);
	});

	test("MUST_REFUSE: an empty orgId throws, naming the missing instrument", async () => {
		const upsertChunks = vi.fn(async () => 0);
		await expect(
			loadChunksBatched(upsertChunks, { orgId: "", scope: "labor-A", chunks: [] }),
		).rejects.toThrow(/orgId/);
		expect(upsertChunks).not.toHaveBeenCalled();
	});

	test("MUST_REFUSE: an empty scope throws, naming the missing instrument", async () => {
		const upsertChunks = vi.fn(async () => 0);
		await expect(
			loadChunksBatched(upsertChunks, { orgId: "org_a", scope: "", chunks: [] }),
		).rejects.toThrow(/scope/);
		expect(upsertChunks).not.toHaveBeenCalled();
	});

	test("MUST_REFUSE: a batchSize of 0 throws", async () => {
		const upsertChunks = vi.fn(async () => 0);
		await expect(
			loadChunksBatched(upsertChunks, {
				orgId: "org_a",
				scope: "labor-A",
				chunks: makeChunks(1),
				batchSize: 0,
			}),
		).rejects.toThrow(/batchSize/);
	});
});
