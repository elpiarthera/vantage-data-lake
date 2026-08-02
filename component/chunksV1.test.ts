/// <reference types="vite/client" />
/**
 * component/chunksV1.test.ts — ported from vantage-memory's
 * convex/__tests__/chunks.test.ts (VP task k170j3b94dpfwxmrm2qxtwm5p18bqqjm,
 * T2), field names renamed to this Component's camelCase convention
 * (chunk_id -> chunkId, legal_references -> legalReferences, source_ref ->
 * sourceRef, insertChunks -> chunksV1.upsert, searchCorpus -> chunksV1.search)
 * and re-wired against convex-test with the COMPONENT's own schema (not the
 * app's), since a Convex Component's test harness runs against its own
 * isolated schema, not the host app's `convex/schema.ts`. Assertions
 * unchanged.
 *
 * RED->GREEN: written before component/chunksV1.ts existed / before the
 * `chunks` table existed in component/schema.ts. Every test below failed
 * against the pre-T2 component (no `chunks` table, "Cannot find module
 * './chunksV1.js'"), then passed once both were added (additive-only
 * schema + new file).
 *
 * AUTH_NAMESPACE_DENIED-style isolation proof: org A can never read org B's
 * chunks via chunksV1.search, proven with a POSITIVE CONTROL (org A finds
 * its own chunk in the same assertion block, so the negative result is not
 * a broken query returning empty for everyone).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

describe("component/chunksV1.ts — upsert + search (BM25-only, no embeddings)", () => {
	test("upsert stores N chunks under (orgId, scope) and returns the count", async () => {
		const t = createT();
		const count = await t.mutation(api.chunksV1.upsert, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunkId: "chunk-1",
					text: "Le contrat de travail à durée indéterminée est la forme normale.",
					sectionTitle: "Article L1221-1",
					legalReferences: ["Code du travail L1221-1"],
					sourceRef: "https://legifrance.gouv.fr/L1221-1",
				},
				{
					chunkId: "chunk-2",
					text: "La période d'essai peut être renouvelée une fois.",
					legalReferences: ["Code du travail L1221-19"],
					sourceRef: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});
		expect(count).toBe(2);
	});

	test("search returns BM25-matched chunks for the caller's own (orgId, scope) — POSITIVE CONTROL", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.upsert, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunkId: "chunk-essai",
					text: "La période d'essai renouvelable une fois pour les cadres.",
					legalReferences: ["L1221-19"],
					sourceRef: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});

		const results = await t.query(api.chunksV1.search, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "période d'essai",
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].chunkId).toBe("chunk-essai");
		expect(results[0].sourceRef).toBe("https://legifrance.gouv.fr/L1221-19");
	});

	test("AUTH_NAMESPACE_DENIED-equivalent — org B cannot read org A's chunks via search (isolation proof, same query text)", async () => {
		const t = createT();

		// Seed org-a with a chunk matching the query text.
		await t.mutation(api.chunksV1.upsert, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunkId: "chunk-secret-a",
					text: "Confidentiel org-a: clause de non-concurrence renforcée.",
					legalReferences: ["L1221-1"],
					sourceRef: "https://legifrance.gouv.fr/org-a",
				},
			],
		});

		// org-b queries the SAME scope with the SAME text but a DIFFERENT orgId.
		const crossTenantResults = await t.query(api.chunksV1.search, {
			orgId: "org-b",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(crossTenantResults).toEqual([]);

		// POSITIVE CONTROL — org-a, same query, DOES see its own chunk. Proves
		// the empty result above is isolation, not a broken/always-empty query.
		const ownResults = await t.query(api.chunksV1.search, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(ownResults.length).toBeGreaterThan(0);
		expect(ownResults[0].chunkId).toBe("chunk-secret-a");
	});

	test("search refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.search, {
				orgId: "",
				scope: "droit-du-travail",
				query: "anything",
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("search refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunksV1.search, {
				orgId: "org-a",
				scope: "",
				query: "anything",
			}),
		).rejects.toThrow(/scope/i);
	});

	test("upsert-by-chunkId idempotence — re-ingesting the same chunkId (same orgId+scope) patches in place, row count stable", async () => {
		const t = createT();
		await t.mutation(api.chunksV1.upsert, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunkId: "chunk-idempotent",
					text: "Article L1234-1 version initiale.",
					sectionTitle: "Rupture du contrat",
					legalReferences: ["L1234-1"],
					sourceRef: "code-travail/L1234-1",
				},
			],
		});

		const secondCount = await t.mutation(api.chunksV1.upsert, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunkId: "chunk-idempotent",
					text: "Article L1234-1 version amendée — texte mis à jour au réingest.",
					sectionTitle: "Rupture du contrat — version amendée",
					legalReferences: ["L1234-1"],
					sourceRef: "code-travail/L1234-1",
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

	test("BM25-only path — search never calls an embedding/AI Gateway endpoint (no-embedding-budget domains)", async () => {
		const t = createT();
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
			fetchCalled = true;
			return originalFetch(...args);
		}) as typeof fetch;

		try {
			await t.mutation(api.chunksV1.upsert, {
				orgId: "org-a",
				scope: "no-embedding-domain",
				chunks: [
					{
						chunkId: "chunk-plain",
						text: "Texte simple sans budget d'embedding.",
						legalReferences: [],
						sourceRef: "https://example.org/plain",
					},
				],
			});

			const results = await t.query(api.chunksV1.search, {
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
});
