/// <reference types="vite/client" />
/**
 * component/documentsV1.test.ts — additive DOCUMENTS layer (VP task
 * k170e3tygkh99a83kj3b72xbed8cf5cf), calqued on chunksV1.test.ts's
 * structure and isolation-proof style.
 *
 * RED (recorded verbatim, captured against this repo BEFORE
 * component/documentsV1.ts existed / before the `documents` table existed
 * in component/schema.ts):
 *
 *   FAIL  component/documentsV1.test.ts [ component/documentsV1.test.ts ]
 *   Error: Failed to resolve import "./documentsV1.js" from
 *   "component/documentsV1.test.ts". Does the file exist?
 *   -- every test in this file failed at collection time because
 *   documentsV1.ts did not export insertDocuments/getDocument/countDocuments
 *   yet, and the `documents` table did not exist in the component schema.
 *
 * GREEN once component/schema.ts's additive `documents` table and
 * component/documentsV1.ts land.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

describe("component/documentsV1.ts — insertDocuments + getDocument (upsert, byte-identical pattern to chunksV1)", () => {
	test("insertDocuments upsert idempotence — re-inserting the same document_id patches in place, never duplicates", async () => {
		const t = createT();

		const firstCount = await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-a",
			scope: "jurisprudence",
			documents: [
				{
					document_id: "arret-1",
					text: "Version initiale de l'arrêt.",
					title: "Cass. soc. 1",
					source_ref: "https://legifrance.gouv.fr/arret-1",
					legal_references: ["L1234-1"],
				},
			],
		});
		expect(firstCount).toBe(1);

		const secondCount = await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-a",
			scope: "jurisprudence",
			documents: [
				{
					document_id: "arret-1",
					text: "Version amendée de l'arrêt.",
					title: "Cass. soc. 1 — amendé",
					source_ref: "https://legifrance.gouv.fr/arret-1",
					legal_references: ["L1234-1"],
				},
			],
		});
		expect(secondCount).toBe(1);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("documents")
				.withIndex("by_org_scope", (q) =>
					q.eq("orgId", "org-a").eq("scope", "jurisprudence"),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].text).toBe("Version amendée de l'arrêt.");
		expect(rows[0].title).toBe("Cass. soc. 1 — amendé");
	});

	test("getDocument round-trip — returns the inserted document", async () => {
		const t = createT();

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-a",
			scope: "jurisprudence",
			documents: [
				{
					document_id: "arret-roundtrip",
					text: "Texte de l'arrêt round-trip.",
					title: "Cass. soc. round-trip",
					source_ref: "https://legifrance.gouv.fr/roundtrip",
					legal_references: ["L1234-2"],
				},
			],
		});

		const doc = await t.query(api.documentsV1.getDocument, {
			orgId: "org-a",
			scope: "jurisprudence",
			document_id: "arret-roundtrip",
		});

		expect(doc).not.toBeNull();
		expect(doc?.document_id).toBe("arret-roundtrip");
		expect(doc?.text).toBe("Texte de l'arrêt round-trip.");
		expect(doc?.title).toBe("Cass. soc. round-trip");
		expect(doc?.source_ref).toBe("https://legifrance.gouv.fr/roundtrip");
		expect(doc?.legal_references).toEqual(["L1234-2"]);
	});

	test("getDocument returns null for a non-existent document_id", async () => {
		const t = createT();

		const doc = await t.query(api.documentsV1.getDocument, {
			orgId: "org-a",
			scope: "jurisprudence",
			document_id: "never-seeded",
		});

		expect(doc).toBeNull();
	});

	test("isolation — a different orgId/scope never sees another tenant's document (getDocument + countDocuments)", async () => {
		const t = createT();

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-secret",
			scope: "jurisprudence",
			documents: [
				{
					document_id: "arret-secret",
					text: "Confidentiel org-secret.",
				},
			],
		});

		// Different orgId, same scope, same document_id — must be invisible.
		const crossTenantDoc = await t.query(api.documentsV1.getDocument, {
			orgId: "org-other",
			scope: "jurisprudence",
			document_id: "arret-secret",
		});
		expect(crossTenantDoc).toBeNull();

		const crossTenantCount = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-other",
			scope: "jurisprudence",
		});
		expect(crossTenantCount).toBe(0);

		// POSITIVE CONTROL — the owning org DOES see its own document.
		const ownDoc = await t.query(api.documentsV1.getDocument, {
			orgId: "org-secret",
			scope: "jurisprudence",
			document_id: "arret-secret",
		});
		expect(ownDoc).not.toBeNull();
		const ownCount = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-secret",
			scope: "jurisprudence",
		});
		expect(ownCount).toBe(1);
	});

	test("insertDocuments refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expect(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "",
				scope: "jurisprudence",
				documents: [{ document_id: "x", text: "x" }],
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("insertDocuments refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expect(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "org-a",
				scope: "",
				documents: [{ document_id: "x", text: "x" }],
			}),
		).rejects.toThrow(/scope/i);
	});
});

// ── countDocuments — O(1) READ FROM THE WRITE-TIME COUNTER
// (`document_scope_counts`), never a scan of the `documents` table itself.
//
// REBUILT (this file): the prior version of this suite proved exactness via
// `.paginate()`-based accumulation, which convex-test PERMITS but the real
// component runtime FORBIDS outright — "paginate() is only supported in the
// app", raised on every scope, empty or not (measured by Talos on prod
// proficient-rabbit-316 and dev dashing-ermine-394; call sites confirmed by
// Pi). This suite now proves the COUNTER's own
// exactness/idempotency/isolation/delete-decrement contract — it does NOT,
// and cannot, prove the code runs on a real component deployment; convex-test
// is strictly more permissive than the component runtime. That activation
// proof is a live call on a real deployment, done separately.
describe("component/documentsV1.ts — countDocuments (write-time counter, exactness + idempotency + delete proof)", () => {
	test("countDocuments stays correct at N=1250 (well past any prior page-size boundary) — counter, not a scan", async () => {
		const t = createT();

		const N = 1250;
		const documents = Array.from({ length: N }, (_, i) => ({
			document_id: `bulk-doc-${i}`,
			text: `Bulk document number ${i}.`,
		}));

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-bulk-docs",
			scope: "bulk-scope",
			documents,
		});

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-bulk-docs",
			scope: "bulk-scope",
		});

		expect(count).toBe(N);
	});

	test("exactness — countDocuments == N inserted, and an idempotent re-upsert of an existing document_id leaves the count UNCHANGED", async () => {
		const t = createT();

		const N = 5;
		const documents = Array.from({ length: N }, (_, i) => ({
			document_id: `exact-doc-${i}`,
			text: `Exactness document number ${i}.`,
		}));

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-exact-docs",
			scope: "exact-scope",
			documents,
		});

		const firstCount = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-exact-docs",
			scope: "exact-scope",
		});
		expect(firstCount).toBe(N);

		// Re-upsert ONE existing document_id (patch-in-place) -- count must
		// stay N, never N+1.
		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-exact-docs",
			scope: "exact-scope",
			documents: [
				{
					document_id: "exact-doc-0",
					text: "Exactness document number 0 — amended on re-ingest.",
				},
			],
		});

		const secondCount = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-exact-docs",
			scope: "exact-scope",
		});
		expect(secondCount).toBe(N);
	});

	test("deleteDocument decrements the counter by exactly 1, and never below 0", async () => {
		const t = createT();

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-del-docs",
			scope: "del-scope",
			documents: [
				{ document_id: "del-doc-1", text: "To be deleted." },
				{ document_id: "del-doc-2", text: "Stays." },
			],
		});

		expect(
			await t.query(api.documentsV1.countDocuments, {
				orgId: "org-del-docs",
				scope: "del-scope",
			}),
		).toBe(2);

		const deleted = await t.mutation(api.documentsV1.deleteDocument, {
			orgId: "org-del-docs",
			scope: "del-scope",
			document_id: "del-doc-1",
		});
		expect(deleted).toBe(true);

		expect(
			await t.query(api.documentsV1.countDocuments, {
				orgId: "org-del-docs",
				scope: "del-scope",
			}),
		).toBe(1);

		// Deleting an already-absent document_id is a no-op — false, count
		// unchanged, never raises, never goes negative.
		const deletedAgain = await t.mutation(api.documentsV1.deleteDocument, {
			orgId: "org-del-docs",
			scope: "del-scope",
			document_id: "del-doc-1",
		});
		expect(deletedAgain).toBe(false);

		expect(
			await t.query(api.documentsV1.countDocuments, {
				orgId: "org-del-docs",
				scope: "del-scope",
			}),
		).toBe(1);

		// Delete the last remaining row — counter reaches 0, never negative.
		await t.mutation(api.documentsV1.deleteDocument, {
			orgId: "org-del-docs",
			scope: "del-scope",
			document_id: "del-doc-2",
		});
		expect(
			await t.query(api.documentsV1.countDocuments, {
				orgId: "org-del-docs",
				scope: "del-scope",
			}),
		).toBe(0);
	});

	test("countDocuments on a non-existent (orgId, scope) returns 0, no error", async () => {
		const t = createT();

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-never-seeded-docs",
			scope: "scope-never-seeded-docs",
		});

		expect(count).toBe(0);
	});

	test("countDocuments refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.documentsV1.countDocuments, {
				orgId: "",
				scope: "some-scope",
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("countDocuments refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-a",
				scope: "",
			}),
		).rejects.toThrow(/scope/i);
	});
});

// ── chunks + document_id — an optional link field, additive-only proof that
// a chunk WITH a document_id round-trips and a chunk WITHOUT one (the
// pre-existing shape) remains valid, via the EXISTING (untouched)
// insertChunks mutation.
describe("component/schema.ts — chunks.document_id (optional link, additive-only proof)", () => {
	test("a chunk inserted with document_id round-trips it via the raw table read", async () => {
		const t = createT();

		await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-link",
			scope: "jurisprudence",
			chunks: [
				{
					chunk_id: "chunk-linked-1",
					text: "Passage lié à un document parent.",
					legal_references: [],
					source_ref: "https://legifrance.gouv.fr/passage-1",
				},
			],
		});

		// insertChunks itself does not accept document_id (untouched contract);
		// the link is written directly here to prove the schema field alone
		// round-trips through the existing table shape.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("chunks")
				.withIndex("by_org_scope_chunk", (q) =>
					q
						.eq("orgId", "org-link")
						.eq("scope", "jurisprudence")
						.eq("chunk_id", "chunk-linked-1"),
				)
				.unique();
			if (row === null) throw new Error("expected seeded chunk row");
			await ctx.db.patch(row._id, { document_id: "arret-parent-1" });
		});

		const linked = await t.run(async (ctx) =>
			ctx.db
				.query("chunks")
				.withIndex("by_org_scope_chunk", (q) =>
					q
						.eq("orgId", "org-link")
						.eq("scope", "jurisprudence")
						.eq("chunk_id", "chunk-linked-1"),
				)
				.unique(),
		);
		expect(linked?.document_id).toBe("arret-parent-1");
	});

	test("a chunk inserted WITHOUT document_id (pre-existing shape) stays valid — no field required", async () => {
		const t = createT();

		const count = await t.mutation(api.chunksV1.insertChunks, {
			orgId: "org-unlinked",
			scope: "jurisprudence",
			chunks: [
				{
					chunk_id: "chunk-unlinked-1",
					text: "Passage sans document parent (forme historique).",
					legal_references: [],
					source_ref: "https://legifrance.gouv.fr/passage-unlinked",
				},
			],
		});
		expect(count).toBe(1);

		const row = await t.run(async (ctx) =>
			ctx.db
				.query("chunks")
				.withIndex("by_org_scope_chunk", (q) =>
					q
						.eq("orgId", "org-unlinked")
						.eq("scope", "jurisprudence")
						.eq("chunk_id", "chunk-unlinked-1"),
				)
				.unique(),
		);
		expect(row).not.toBeNull();
		expect(row?.document_id).toBeUndefined();
	});
});
