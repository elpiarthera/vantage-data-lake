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
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

// expectRefusal — asserts a rejected promise is a structured `ConvexError`
// (Pi + operator finding, follow-up to REVISE rounds 1-2: a plain Error
// reaches every Convex client as an opaque "Server Error" + a request id;
// only ConvexError carries a payload across the client boundary). Matching
// only the message string does NOT prove the payload crosses the boundary —
// this asserts `error.data.code`/`orgId`/`scope` as DATA, the actual shape a
// client reads.
async function expectRefusal(
	promise: Promise<unknown>,
	code: string,
	orgId: string,
	scope: string,
): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	const convexError = caught as ConvexError<string>;
	// convex-test round-trips `.data` through the wire exactly like a real
	// Convex client — it arrives JSON-STRINGIFIED, not as a live object. This
	// IS the proof the payload survives serialization to the client
	// boundary; parsing it here is the same step a real consumer takes.
	const data =
		typeof convexError.data === "string"
			? JSON.parse(convexError.data)
			: convexError.data;
	expect(data).toMatchObject({ code, orgId, scope });
}

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
		await expectRefusal(
			t.query(api.chunksV1.searchCorpus, {
				orgId: "",
				scope: "droit-du-travail",
				query: "anything",
			}),
			"org_required",
			"",
			"droit-du-travail",
		);
	});

	test("searchCorpus refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expectRefusal(
			t.query(api.chunksV1.searchCorpus, {
				orgId: "org-a",
				scope: "",
				query: "anything",
			}),
			"scope_required",
			"org-a",
			"",
		);
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

// ── countChunks — O(1) READ FROM THE WRITE-TIME COUNTER
// (`chunk_scope_counts`), never a scan of the `chunks` table itself.
//
// REBUILT (this file): the prior version of this suite proved exactness via
// `.paginate()`-based accumulation, which convex-test PERMITS but the real
// component runtime FORBIDS outright — "paginate() is only supported in the
// app", raised on every scope, empty or not (measured by Talos on prod
// proficient-rabbit-316 and dev dashing-ermine-394; call sites confirmed by
// Pi). The 32/32 green suite that motivated this rebuild was a FALSE green
// for exactly that reason. This suite now proves the COUNTER's own
// exactness/idempotency/isolation/delete-decrement contract — it does NOT,
// and cannot, prove the code runs on a real component deployment; convex-test
// is strictly more permissive than the component runtime. That activation
// proof is a live call on a real deployment, done separately.
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

	test("unmeasured scope — countChunks on a non-existent (orgId, scope) THROWS, never a silent 0", async () => {
		const t = createT();

		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-never-seeded",
				scope: "scope-never-seeded",
			}),
			"scope_not_initialized",
			"org-never-seeded",
			"scope-never-seeded",
		);
	});

	test("countChunks refuses an empty orgId — deny by default, same guard as insertChunks/searchCorpus", async () => {
		const t = createT();
		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "",
				scope: "some-scope",
			}),
			"org_required",
			"",
			"some-scope",
		);
	});

	test("countChunks refuses an empty scope — deny by default, same guard as insertChunks/searchCorpus", async () => {
		const t = createT();
		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-count",
				scope: "",
			}),
			"scope_required",
			"org-count",
			"",
		);
	});

	test("countChunks stays O(1)-correct at N=1250 (well past any prior page-size boundary) — counter, not a scan", async () => {
		const t = createT();

		const N = 1250;
		const chunks = Array.from({ length: N }, (_, i) => ({
			chunk_id: `bulk-${i}`,
			text: `Bulk counter chunk number ${i}.`,
			legal_references: [],
			source_ref: `src/bulk-${i}`,
		}));

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-bulk",
			scope: "bulk-scope",
			chunks,
		});

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-bulk",
			scope: "bulk-scope",
		});

		expect(count).toBe(N);
	});

	test("deleteChunk decrements the counter by exactly 1, and never below 0", async () => {
		const t = createT();

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-del",
			scope: "del-scope",
			chunks: [
				{
					chunk_id: "del-1",
					text: "To be deleted.",
					legal_references: [],
					source_ref: "src/del-1",
				},
				{
					chunk_id: "del-2",
					text: "Stays.",
					legal_references: [],
					source_ref: "src/del-2",
				},
			],
		});

		expect(
			await t.query(api.chunksV1.countChunks, {
				orgId: "org-del",
				scope: "del-scope",
			}),
		).toBe(2);

		const deleted = await t.mutation(api.chunksV1.deleteChunk, {
			orgId: "org-del",
			scope: "del-scope",
			chunk_id: "del-1",
		});
		expect(deleted).toBe(true);

		expect(
			await t.query(api.chunksV1.countChunks, {
				orgId: "org-del",
				scope: "del-scope",
			}),
		).toBe(1);

		// Deleting an already-absent chunk_id is a no-op — false, count
		// unchanged, never raises, never goes negative.
		const deletedAgain = await t.mutation(api.chunksV1.deleteChunk, {
			orgId: "org-del",
			scope: "del-scope",
			chunk_id: "del-1",
		});
		expect(deletedAgain).toBe(false);

		expect(
			await t.query(api.chunksV1.countChunks, {
				orgId: "org-del",
				scope: "del-scope",
			}),
		).toBe(1);

		// Delete the last remaining row — counter reaches 0, never negative.
		await t.mutation(api.chunksV1.deleteChunk, {
			orgId: "org-del",
			scope: "del-scope",
			chunk_id: "del-2",
		});
		expect(
			await t.query(api.chunksV1.countChunks, {
				orgId: "org-del",
				scope: "del-scope",
			}),
		).toBe(0);
	});
});

// ── bootstrapScopeCount — historical-scope reconciliation (Eta REVISE,
// PR #11 @616e8197: countChunks returning 0 on an unmeasured scope is a
// silent lie; this suite proves the refuse-then-bootstrap-then-authoritative
// lifecycle, RED before the fix existed).
describe("component/chunksV1.ts — bootstrapScopeCount (historical scopes, refuse->bootstrap->authoritative)", () => {
	// Directly inserts rows into `chunks` bypassing insertChunks, simulating
	// the 144283 historical rows written before the write-time counter
	// existed — no `chunk_scope_counts` row is ever created for them.
	async function seedHistoricalChunks(
		t: ReturnType<typeof createT>,
		orgId: string,
		scope: string,
		n: number,
	) {
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < n; i++) {
				await ctx.db.insert("chunks", {
					orgId,
					scope,
					chunk_id: `hist-${String(i).padStart(5, "0")}`,
					text: `Historical chunk ${i}, written before the counter existed.`,
					legal_references: [],
					source_ref: `src/hist-${i}`,
					createdAt: now,
				});
			}
		});
	}

	test("BEFORE bootstrap: countChunks throws on a scope with historical (pre-counter) rows — never a silent 0", async () => {
		const t = createT();
		await seedHistoricalChunks(t, "org-hist", "hist-scope", 12);

		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-hist",
				scope: "hist-scope",
			}),
			"scope_not_initialized",
			"org-hist",
			"hist-scope",
		);
	});

	test("bootstrapScopeCount walks a historical scope to completion; total === N; countChunks then returns N", async () => {
		const t = createT();
		const N = 137;
		await seedHistoricalChunks(t, "org-boot", "boot-scope", N);

		let result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-boot",
			scope: "boot-scope",
			pageSize: 25,
		});
		let iterations = 1;
		while (!result.done) {
			result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
				orgId: "org-boot",
				scope: "boot-scope",
				pageSize: 25,
			});
			iterations += 1;
			if (iterations > 100) throw new Error("bootstrap loop did not converge");
		}

		expect(result.total).toBe(N);

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-boot",
			scope: "boot-scope",
		});
		expect(count).toBe(N);
	});

	test("a scope seeded via insertChunks (status ready from row zero) needs NO bootstrap — countChunks works immediately", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-live",
			scope: "live-scope",
			chunks: [
				{
					chunk_id: "live-1",
					text: "Live-ingested chunk, never touched bootstrap.",
					legal_references: [],
					source_ref: "src/live-1",
				},
			],
		});

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-live",
			scope: "live-scope",
		});
		expect(count).toBe(1);
	});

	test("idempotence — bootstrapScopeCount called again after done:true returns {done:true, total:N} and does not change the count", async () => {
		const t = createT();
		const N = 40;
		await seedHistoricalChunks(t, "org-idem", "idem-scope", N);

		let result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-idem",
			scope: "idem-scope",
			pageSize: 500,
		});
		while (!result.done) {
			result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
				orgId: "org-idem",
				scope: "idem-scope",
				pageSize: 500,
			});
		}
		expect(result.total).toBe(N);

		const again = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-idem",
			scope: "idem-scope",
			pageSize: 500,
		});
		expect(again).toEqual({ done: true, processed: 0, total: N, cursor: "" });

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-idem",
			scope: "idem-scope",
		});
		expect(count).toBe(N);
	});

	test("empty-but-ready scope (bootstrapped with zero historical rows) returns 0 legitimately", async () => {
		const t = createT();

		let result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-empty-ready",
			scope: "empty-ready-scope",
		});
		expect(result).toEqual({ done: true, processed: 0, total: 0, cursor: "" });

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-empty-ready",
			scope: "empty-ready-scope",
		});
		expect(count).toBe(0);
	});

	test("mid-bootstrap: countChunks throws while status is still bootstrapping (partial walk, not yet done)", async () => {
		const t = createT();
		const N = 60;
		await seedHistoricalChunks(t, "org-partial", "partial-scope", N);

		const partial = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-partial",
			scope: "partial-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-partial",
				scope: "partial-scope",
			}),
			"scope_bootstrap_in_progress",
			"org-partial",
			"partial-scope",
		);
	});

	test("interrupted then resumed bootstrap — stops before done, countChunks throws in the interval, resuming reaches exact total with no double-count and no loss", async () => {
		const t = createT();
		const N = 97;
		await seedHistoricalChunks(t, "org-resume", "resume-scope", N);

		// First call only — deliberately NOT looped to completion.
		const interrupted = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-resume",
			scope: "resume-scope",
			pageSize: 20,
		});
		expect(interrupted.done).toBe(false);
		expect(interrupted.total).toBeLessThan(N);

		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-resume",
				scope: "resume-scope",
			}),
			"scope_bootstrap_in_progress",
			"org-resume",
			"resume-scope",
		);

		// Resume to completion.
		let result = interrupted;
		let iterations = 1;
		while (!result.done) {
			result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
				orgId: "org-resume",
				scope: "resume-scope",
				pageSize: 20,
			});
			iterations += 1;
			if (iterations > 100) throw new Error("resume loop did not converge");
		}

		expect(result.total).toBe(N);
		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-resume",
			scope: "resume-scope",
		});
		expect(count).toBe(N);
	});

	test("insertChunks refuses a write to a bootstrapping scope — write-race class closed, not merely documented", async () => {
		const t = createT();
		const N = 30;
		await seedHistoricalChunks(t, "org-race", "race-scope", N);

		const partial = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-race",
			scope: "race-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.mutation(api.chunksV1.insertChunks, {
				orgId: "org-race",
				scope: "race-scope",
				chunks: [
					{
						chunk_id: "race-new",
						text: "Racing an in-progress bootstrap.",
						legal_references: [],
						source_ref: "src/race-new",
					},
				],
			}),
			"write_refused_bootstrapping",
			"org-race",
			"race-scope",
		);
	});

	test("deleteChunk refuses a delete on a bootstrapping scope", async () => {
		const t = createT();
		const N = 30;
		await seedHistoricalChunks(t, "org-race-del", "race-del-scope", N);

		const partial = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-race-del",
			scope: "race-del-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.mutation(api.chunksV1.deleteChunk, {
				orgId: "org-race-del",
				scope: "race-del-scope",
				chunk_id: "hist-00000",
			}),
			"write_refused_bootstrapping",
			"org-race-del",
			"race-del-scope",
		);
	});

	test("insertChunks on a ready scope passes and increments normally", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-ready-write",
			scope: "ready-write-scope",
			chunks: [
				{
					chunk_id: "seed-1",
					text: "Seeds a ready scope.",
					legal_references: [],
					source_ref: "src/seed-1",
				},
			],
		});

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-ready-write",
			scope: "ready-write-scope",
			chunks: [
				{
					chunk_id: "seed-2",
					text: "Second write to an already-ready scope.",
					legal_references: [],
					source_ref: "src/seed-2",
				},
			],
		});

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-ready-write",
			scope: "ready-write-scope",
		});
		expect(count).toBe(2);
	});

	test("ETA-PROBE2: a scope with N=10 pre-existing (historical, un-bootstrapped) rows THROWS on the first insertChunks call — never a false ready-1", async () => {
		const t = createT();
		await seedHistoricalChunks(t, "org-eta-probe2", "eta-probe2-scope", 10);

		await expectRefusal(
			t.mutation(api.chunksV1.insertChunks, {
				orgId: "org-eta-probe2",
				scope: "eta-probe2-scope",
				chunks: [
					{
						chunk_id: "eta-probe2-new",
						text: "First live write onto a historical, un-bootstrapped scope.",
						legal_references: [],
						source_ref: "src/eta-probe2-new",
					},
				],
			}),
			"scope_has_unmeasured_rows",
			"org-eta-probe2",
			"eta-probe2-scope",
		);

		// countChunks still throws — no false-ready-1 was ever stamped.
		await expectRefusal(
			t.query(api.chunksV1.countChunks, {
				orgId: "org-eta-probe2",
				scope: "eta-probe2-scope",
			}),
			"scope_not_initialized",
			"org-eta-probe2",
			"eta-probe2-scope",
		);

		// Bootstrap is required and, once run to completion, is authoritative
		// at N=10 (the historical rows) — the refused insert never landed.
		let result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-eta-probe2",
			scope: "eta-probe2-scope",
		});
		while (!result.done) {
			result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
				orgId: "org-eta-probe2",
				scope: "eta-probe2-scope",
			});
		}
		expect(result.total).toBe(10);

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-eta-probe2",
			scope: "eta-probe2-scope",
		});
		expect(count).toBe(10);
	});

	test("fresh-scope order trap — two successive insertChunks calls on a brand-new scope both pass; countChunks returns the sum, no throw", async () => {
		const t = createT();

		const first = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-order-trap",
			scope: "order-trap-scope",
			chunks: [
				{
					chunk_id: "trap-1",
					text: "First call on a scope that has never existed before.",
					legal_references: [],
					source_ref: "src/trap-1",
				},
			],
		});
		expect(first).toBe(1);

		const second = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-order-trap",
			scope: "order-trap-scope",
			chunks: [
				{
					chunk_id: "trap-2",
					text: "Second call — the scope is now ready.",
					legal_references: [],
					source_ref: "src/trap-2",
				},
			],
		});
		expect(second).toBe(1);

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-order-trap",
			scope: "order-trap-scope",
		});
		expect(count).toBe(2);
	});

	// Directly inserts rows with a LARGE `text` field, simulating the prod
	// defect that motivated (and then falsified) the byte-budget attempt:
	// "Uncaught Error: Too many bytes read in a single function execution
	// (limit: 16777216 bytes)". A fixed pageSize=500 `.take()` (0.4.1-0.4.5)
	// materializes whole documents purely to count them, and voluminous
	// legal-ruling text crosses 16MiB well under 500 rows.
	async function seedLargeHistoricalChunks(
		t: ReturnType<typeof createT>,
		orgId: string,
		scope: string,
		n: number,
		textBytes: number,
	) {
		const bigText = "x".repeat(textBytes);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < n; i++) {
				await ctx.db.insert("chunks", {
					orgId,
					scope,
					chunk_id: `big-${String(i).padStart(5, "0")}`,
					text: bigText,
					legal_references: [],
					source_ref: `src/big-${i}`,
					createdAt: now,
				});
			}
		});
	}

	// 0.4.7 CORRECTION (0.4.6 false fix): a JS-side `break` over a
	// `for await` iterator does NOT bound the bytes the Convex runtime
	// reads — the iterator prefetches storage ahead of JS consumption, so
	// accumulating `bytesSoFar` and breaking on a budget only stopped the
	// LOOP, never the read the runtime had already issued. Measured
	// firsthand by the coordinator on a real dev deployment: 25
	// counter-less rows of ~700 KB each still threw "Too many bytes read
	// (limit: 16777216)" under the 0.4.6 "byte-budget" logic. The fix is
	// `.take(k)` — the ONLY construct that bounds what the Convex runtime
	// actually reads to exactly k documents.
	//
	// CAVEAT (stated, not hidden): convex-test does NOT enforce the real
	// Convex runtime's 16MiB-per-execution read limit — this suite proves
	// the page-bounded-by-.take(k) LOGIC (a round returns EXACTLY k rows,
	// deterministically, never more), NOT that .take(k) avoids the real
	// limit on a live deployment (that follows structurally from Convex's
	// 1 MiB max document size × k ≤ 15, but is not something convex-test
	// can measure). The REAL proof is re-staging on the dev deployment (the
	// byte-budget-proof scope of 25×700KB rows already exists on
	// dashing-ermine-394) and bootstrapping to done WITHOUT the throw — a
	// post-merge, post-publish step run at the endpoint, not provable here.
	test(".take(k)-bounded bootstrap: each round returns EXACTLY k=pageSize rows (deterministic, not JS-side byte estimation) for large-text historical chunks; final total exact, no double-count on resume", async () => {
		const t = createT();
		// Each row ~= 300KB of `text`. pageSize=8 explicit (matches
		// SAFE_DEFAULT_PAGE) — deterministic assertion: every non-final round
		// returns EXACTLY 8, never more, never a byte-dependent number.
		const N = 40;
		const pageSize = 8;
		const textBytes = 300 * 1024;
		await seedLargeHistoricalChunks(t, "org-takebound", "takebound-scope", N, textBytes);

		const first = await t.mutation(api.chunksV1.bootstrapScopeCount, {
			orgId: "org-takebound",
			scope: "takebound-scope",
			pageSize,
		});
		expect(first.done).toBe(false);
		// The defining assertion: this round's processed count is EXACTLY
		// pageSize — .take(k) bounds the read deterministically, not a
		// byte-estimation heuristic that could vary with content.
		expect(first.processed).toBe(pageSize);

		let result = first;
		let iterations = 1;
		while (!result.done) {
			result = await t.mutation(api.chunksV1.bootstrapScopeCount, {
				orgId: "org-takebound",
				scope: "takebound-scope",
				pageSize,
			});
			iterations += 1;
			if (iterations > 50) throw new Error("take(k) bootstrap loop did not converge");
			if (!result.done) {
				expect(result.processed).toBe(pageSize);
			}
		}

		expect(result.total).toBe(N);
		// N=40 / pageSize=8 = exactly 5 rounds — deterministic, proving the
		// split is driven by .take(k), not an estimate.
		expect(iterations).toBe(N / pageSize + 1); // 5 data rounds of exactly pageSize + 1 final round (processed:0) that flips status to ready

		const count = await t.query(api.chunksV1.countChunks, {
			orgId: "org-takebound",
			scope: "takebound-scope",
		});
		expect(count).toBe(N);
	});
});
