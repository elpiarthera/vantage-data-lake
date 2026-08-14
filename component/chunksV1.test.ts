/// <reference types="vite/client" />
/**
 * component/chunksV1.test.ts — ported from vantage-memory's
 * convex/__tests__/chunks.test.ts (VP task k170j3b94dpfwxmrm2qxtwm5p18bqqjm,
 * T2), then reconciled to @vantageos/corpus's byte-identical snake_case
 * contract in T3 (k170v3p0sxty10jv8ba9vg45x18bpbeq): field names restored
 * to chunk_id / section_title / legal_references / source_ref, and the
 * exported functions renamed chunksV1.upsert -> chunksV1.insertChunks,
 * chunksV1.search -> chunksV1.searchCorpus, matching corpus's own
 * component/corpus.ts naming 1:1. Re-wired against convex-test with the
 * COMPONENT's own schema (not the app's), since a Convex Component's test
 * harness runs against its own isolated schema, not the host app's
 * `convex/schema.ts`. Assertions unchanged in substance.
 *
 * RED->GREEN (T2): written before component/chunksV1.ts existed / before
 * the `chunks` table existed in component/schema.ts. Every test below
 * failed against the pre-T2 component (no `chunks` table, "Cannot find
 * module './chunksV1.js'"), then passed once both were added
 * (additive-only schema + new file).
 *
 * RED->GREEN (T3, corpus contract test at the bottom of this file): written
 * before `insertChunks`/`searchCorpus` existed on chunksV1 (only
 * `upsert`/`search` with camelCase fields existed) — failed with
 * "api.chunksV1.insertChunks is not a function" / camelCase field mismatch,
 * then passed once T3's rename + snake_case reconciliation landed.
 *
 * AUTH_NAMESPACE_DENIED-style isolation proof: org A can never read org B's
 * chunks via chunksV1.searchCorpus, proven with a POSITIVE CONTROL (org A
 * finds its own chunk in the same assertion block, so the negative result
 * is not a broken query returning empty for everyone).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

describe("component/chunksV1.ts — insertChunks + searchCorpus (BM25-only, no embeddings)", () => {
	test("insertChunks stores N chunks under (orgId, scope) and returns the count", async () => {
		const t = createT();
		const count = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-1",
					text: "Le contrat de travail à durée indéterminée est la forme normale.",
					section_title: "Article L1221-1",
					legal_references: ["Code du travail L1221-1"],
					source_ref: "https://legifrance.gouv.fr/L1221-1",
				},
				{
					chunk_id: "chunk-2",
					text: "La période d'essai peut être renouvelée une fois.",
					legal_references: ["Code du travail L1221-19"],
					source_ref: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});
		expect(count).toBe(2);
	});

	test("searchCorpus returns BM25-matched chunks for the caller's own (orgId, scope) — POSITIVE CONTROL", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-essai",
					text: "La période d'essai renouvelable une fois pour les cadres.",
					legal_references: ["L1221-19"],
					source_ref: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});

		const results = await t.query(api.chunksV1.searchCorpus, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "période d'essai",
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].chunk_id).toBe("chunk-essai");
		expect(results[0].source_ref).toBe("https://legifrance.gouv.fr/L1221-19");
	});

	test("AUTH_NAMESPACE_DENIED-equivalent — org B cannot read org A's chunks via searchCorpus (isolation proof, same query text)", async () => {
		const t = createT();

		// Seed org-a with a chunk matching the query text.
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-secret-a",
					text: "Confidentiel org-a: clause de non-concurrence renforcée.",
					legal_references: ["L1221-1"],
					source_ref: "https://legifrance.gouv.fr/org-a",
				},
			],
		});

		// org-b queries the SAME scope with the SAME text but a DIFFERENT orgId.
		const crossTenantResults = await t.query(api.chunksV1.searchCorpus, {
			orgId: "org-b",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(crossTenantResults).toEqual([]);

		// POSITIVE CONTROL — org-a, same query, DOES see its own chunk. Proves
		// the empty result above is isolation, not a broken/always-empty query.
		const ownResults = await t.query(api.chunksV1.searchCorpus, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(ownResults.length).toBeGreaterThan(0);
		expect(ownResults[0].chunk_id).toBe("chunk-secret-a");
	});

	test("searchCorpus refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.searchCorpus, {
				orgId: "",
				scope: "droit-du-travail",
				query: "anything",
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("searchCorpus refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.searchCorpus, {
				orgId: "org-a",
				scope: "",
				query: "anything",
			}),
		).rejects.toThrow(/scope/i);
	});

	test("insertChunks-by-chunk_id idempotence — re-ingesting the same chunk_id (same orgId+scope) patches in place, row count stable", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-idempotent",
					text: "Article L1234-1 version initiale.",
					section_title: "Rupture du contrat",
					legal_references: ["L1234-1"],
					source_ref: "code-travail/L1234-1",
				},
			],
		});

		const secondCount = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-idempotent",
					text: "Article L1234-1 version amendée — texte mis à jour au réingest.",
					section_title: "Rupture du contrat — version amendée",
					legal_references: ["L1234-1"],
					source_ref: "code-travail/L1234-1",
				},
			],
		});
		expect(secondCount).toBe(1);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("chunks")
				.withIndex("by_org_scope", (q) =>
					q.eq("orgId", "org-a").eq("scope", "droit-du-travail"),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].text).toBe(
			"Article L1234-1 version amendée — texte mis à jour au réingest.",
		);
	});

	test("BM25-only path — searchCorpus never calls an embedding/AI Gateway endpoint (no-embedding-budget domains)", async () => {
		const t = createT();
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
			fetchCalled = true;
			return originalFetch(...args);
		}) as typeof fetch;

		try {
			await t.mutation(api.chunksV1.insertChunks, {
				orgId: "org-a",
				scope: "no-embedding-domain",
				chunks: [
					{
						chunk_id: "chunk-plain",
						text: "Texte simple sans budget d'embedding.",
						legal_references: [],
						source_ref: "https://example.org/plain",
					},
				],
			});

			const results = await t.query(api.chunksV1.searchCorpus, {
				orgId: "org-a",
				scope: "no-embedding-domain",
				query: "texte simple",
			});

			expect(results.length).toBeGreaterThan(0);
			// Native Convex BM25 search runs inside the deployment's own query
			// engine — no outbound `fetch` (i.e. no embedding/AI Gateway call)
			// is ever made by this path.
			expect(fetchCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// ── T3 corpus-contract-parity test ────────────────────────────────────────
	// Asserts the @vantageos/corpus public contract (insertChunks / searchCorpus,
	// snake_case args + results) works end-to-end via data-lake's chunksV1
	// namespace — the acceptance criterion for a zero-code-change CONVEX_URL
	// repoint by Talos/Thémis. RED before T3 (functions were named upsert/search
	// with camelCase fields), GREEN after this file's T3 rename.
	test("T3 corpus-contract parity — insertChunks then searchCorpus round-trips the exact corpus wire shape", async () => {
		const t = createT();

		const insertedCount = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-thales",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-corpus-parity",
					text: "Le licenciement pour motif économique obéit à une procédure stricte.",
					section_title: "Article L1233-1",
					legal_references: ["Code du travail L1233-1"],
					source_ref: "https://legifrance.gouv.fr/L1233-1",
				},
			],
		});
		expect(insertedCount).toBe(1);

		const results = await t.query(api.chunksV1.searchCorpus, {
			orgId: "org-thales",
			scope: "droit-du-travail",
			query: "licenciement motif économique",
		});

		expect(results.length).toBeGreaterThan(0);
		const [row] = results;
		// Result shape is byte-identical to corpus's searchCorpus: snake_case
		// keys, no camelCase leakage anywhere in the response.
		expect(Object.keys(row).sort()).toEqual(
			[
				"chunk_id",
				"legal_references",
				"scope",
				"section_title",
				"source_ref",
				"text",
			].sort(),
		);
		expect(row.chunk_id).toBe("chunk-corpus-parity");
		expect(row.section_title).toBe("Article L1233-1");
		expect(row.legal_references).toEqual(["Code du travail L1233-1"]);
		expect(row.source_ref).toBe("https://legifrance.gouv.fr/L1233-1");
		expect(row.scope).toBe("droit-du-travail");
	});
});

// ── countChunks — in-base count, read FROM THE DATABASE, never from what was
// sent (derive-never-type: insertChunks's return is "chunks processed by this
// call", NOT a corpus-completeness proof). countChunks answers "how many rows
// actually exist for (orgId, scope) right now", filtered via the same
// by_org_scope_chunk index insertChunks/searchCorpus already use — never an
// unfiltered/global scan.
//
// RED (recorded verbatim, captured against this repo BEFORE
// component/chunksV1.ts exported countChunks):
//
//   FAIL  component/chunksV1.test.ts [ component/chunksV1.test.ts ]
//   TypeError: api.chunksV1.countChunks is not a function
//   -- every test in this describe block failed at call time, because
//   countChunks did not exist on chunksV1 yet.
describe("component/chunksV1.ts — countChunks (in-base count, isolation + exactness proof)", () => {
	test("countChunks(A) never counts B's rows — isolation across scope, same orgId", async () => {
		const t = createT();

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-count",
			scope: "scope-a",
			chunks: [
				{
					chunk_id: "count-a-1",
					text: "Chunk scope A, one.",
					legal_references: [],
					source_ref: "src/a-1",
				},
				{
					chunk_id: "count-a-2",
					text: "Chunk scope A, two.",
					legal_references: [],
					source_ref: "src/a-2",
				},
			],
		});
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-count",
			scope: "scope-b",
			chunks: [
				{
					chunk_id: "count-b-1",
					text: "Chunk scope B, one.",
					legal_references: [],
					source_ref: "src/b-1",
				},
			],
		});

		const countA = await t.query(api.chunksV1.countChunks, {
			orgId: "org-count",
			scope: "scope-a",
		});
		const countB = await t.query(api.chunksV1.countChunks, {
			orgId: "org-count",
			scope: "scope-b",
		});

		expect(countA).toBe(2);
		expect(countB).toBe(1);
	});

	test("countChunks(A) never counts B's rows — isolation across orgId, same scope", async () => {
		const t = createT();

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-count-x",
			scope: "shared-scope",
			chunks: [
				{
					chunk_id: "x-1",
					text: "Org X chunk one.",
					legal_references: [],
					source_ref: "src/x-1",
				},
				{
					chunk_id: "x-2",
					text: "Org X chunk two.",
					legal_references: [],
					source_ref: "src/x-2",
				},
				{
					chunk_id: "x-3",
					text: "Org X chunk three.",
					legal_references: [],
					source_ref: "src/x-3",
				},
			],
		});
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-count-y",
			scope: "shared-scope",
			chunks: [
				{
					chunk_id: "y-1",
					text: "Org Y chunk one.",
					legal_references: [],
					source_ref: "src/y-1",
				},
			],
		});

		const countX = await t.query(api.chunksV1.countChunks, {
			orgId: "org-count-x",
			scope: "shared-scope",
		});
		const countY = await t.query(api.chunksV1.countChunks, {
			orgId: "org-count-y",
			scope: "shared-scope",
		});

		expect(countX).toBe(3);
		expect(countY).toBe(1);
	});

	test("exactness — countChunks == N inserted, and an idempotent re-upsert of an existing chunk_id leaves the count UNCHANGED", async () => {
		const t = createT();

		const N = 5;
		const chunks = Array.from({ length: N }, (_, i) => ({
			chunk_id: `exact-${i}`,
			text: `Exactness chunk number ${i}.`,
			legal_references: [],
			source_ref: `src/exact-${i}`,
		}));

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-exact",
			scope: "exact-scope",
			chunks,
		});

		const firstCount = await t.query(api.chunksV1.countChunks, {
			orgId: "org-exact",
			scope: "exact-scope",
		});
		expect(firstCount).toBe(N);

		// Re-upsert ONE existing chunk_id (patch-in-place, per insertChunks'
		// own idempotence contract) -- count must stay N, never N+1.
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-exact",
			scope: "exact-scope",
			chunks: [
				{
					chunk_id: "exact-0",
					text: "Exactness chunk number 0 — amended text on re-ingest.",
					legal_references: [],
					source_ref: "src/exact-0",
				},
			],
		});

		const secondCount = await t.query(api.chunksV1.countChunks, {
			orgId: "org-exact",
			scope: "exact-scope",
		});
		expect(secondCount).toBe(N);
	});

	test("empty scope — countChunks on a non-existent (orgId, scope) returns 0, no error", async () => {
		const t = createT();

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-never-seeded",
			scope: "scope-never-seeded",
		});

		expect(count).toBe(0);
	});

	test("countChunks refuses an empty orgId — deny by default, same guard as insertChunks/searchCorpus", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.countChunks, {
				orgId: "",
				scope: "some-scope",
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("countChunks refuses an empty scope — deny by default, same guard as insertChunks/searchCorpus", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-count",
				scope: "",
			}),
		).rejects.toThrow(/scope/i);
	});
});
