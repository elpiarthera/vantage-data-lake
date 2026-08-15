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
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

// expectRefusal — mirrors chunksV1.test.ts's helper 1:1: asserts a rejected
// promise is a structured ConvexError, checking `error.data.code`/`orgId`/
// `scope` as DATA (not just the message string) — the actual shape a client
// reads across the Convex boundary.
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

		// org-other/jurisprudence was never seeded — an unmeasured scope
		// throws rather than returning a silent 0 (Eta REVISE, PR #11
		// @616e8197). Isolation is still proven: the throw carries no leak of
		// org-secret's count, and the positive control below confirms
		// org-secret's own count is exact.
		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-other",
				scope: "jurisprudence",
			}),
			"scope_not_initialized",
			"org-other",
			"jurisprudence",
		);

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
		await expectRefusal(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "",
				scope: "jurisprudence",
				documents: [{ document_id: "x", text: "x" }],
			}),
			"org_required",
			"",
			"jurisprudence",
		);
	});

	test("insertDocuments refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expectRefusal(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "org-a",
				scope: "",
				documents: [{ document_id: "x", text: "x" }],
			}),
			"scope_required",
			"org-a",
			"",
		);
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

	test("unmeasured scope — countDocuments on a non-existent (orgId, scope) THROWS, never a silent 0", async () => {
		const t = createT();

		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-never-seeded-docs",
				scope: "scope-never-seeded-docs",
			}),
			"scope_not_initialized",
			"org-never-seeded-docs",
			"scope-never-seeded-docs",
		);
	});

	test("countDocuments refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "",
				scope: "some-scope",
			}),
			"org_required",
			"",
			"some-scope",
		);
	});

	test("countDocuments refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-a",
				scope: "",
			}),
			"scope_required",
			"org-a",
			"",
		);
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

// ── bootstrapDocumentScopeCount — historical-scope reconciliation (Eta
// REVISE, PR #11 @616e8197, mirrored 1:1 from chunksV1's suite).
describe("component/documentsV1.ts — bootstrapDocumentScopeCount (historical scopes, refuse->bootstrap->authoritative)", () => {
	// Directly inserts rows into `documents` bypassing insertDocuments,
	// simulating historical rows written before the write-time counter
	// existed — no `document_scope_counts` row is ever created for them.
	async function seedHistoricalDocuments(
		t: ReturnType<typeof createT>,
		orgId: string,
		scope: string,
		n: number,
	) {
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < n; i++) {
				await ctx.db.insert("documents", {
					orgId,
					scope,
					document_id: `hist-doc-${String(i).padStart(5, "0")}`,
					text: `Historical document ${i}, written before the counter existed.`,
					createdAt: now,
				});
			}
		});
	}

	test("BEFORE bootstrap: countDocuments throws on a scope with historical (pre-counter) rows — never a silent 0", async () => {
		const t = createT();
		await seedHistoricalDocuments(t, "org-hist-docs", "hist-scope", 12);

		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-hist-docs",
				scope: "hist-scope",
			}),
			"scope_not_initialized",
			"org-hist-docs",
			"hist-scope",
		);
	});

	test("bootstrapDocumentScopeCount walks a historical scope to completion; total === N; countDocuments then returns N", async () => {
		const t = createT();
		const N = 137;
		await seedHistoricalDocuments(t, "org-boot-docs", "boot-scope", N);

		let result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-boot-docs",
			scope: "boot-scope",
			pageSize: 25,
		});
		let iterations = 1;
		while (!result.done) {
			result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
				orgId: "org-boot-docs",
				scope: "boot-scope",
				pageSize: 25,
			});
			iterations += 1;
			if (iterations > 100) throw new Error("bootstrap loop did not converge");
		}

		expect(result.total).toBe(N);

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-boot-docs",
			scope: "boot-scope",
		});
		expect(count).toBe(N);
	});

	test("a scope seeded via insertDocuments (status ready from row zero) needs NO bootstrap — countDocuments works immediately", async () => {
		const t = createT();
		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-live-docs",
			scope: "live-scope",
			documents: [
				{
					document_id: "live-1",
					text: "Live-ingested document, never touched bootstrap.",
				},
			],
		});

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-live-docs",
			scope: "live-scope",
		});
		expect(count).toBe(1);
	});

	test("idempotence — bootstrapDocumentScopeCount called again after done:true returns {done:true, total:N} and does not change the count", async () => {
		const t = createT();
		const N = 40;
		await seedHistoricalDocuments(t, "org-idem-docs", "idem-scope", N);

		let result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-idem-docs",
			scope: "idem-scope",
			pageSize: 500,
		});
		while (!result.done) {
			result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
				orgId: "org-idem-docs",
				scope: "idem-scope",
				pageSize: 500,
			});
		}
		expect(result.total).toBe(N);

		const again = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-idem-docs",
			scope: "idem-scope",
			pageSize: 500,
		});
		expect(again).toEqual({ done: true, processed: 0, total: N, cursor: "" });

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-idem-docs",
			scope: "idem-scope",
		});
		expect(count).toBe(N);
	});

	test("empty-but-ready scope (bootstrapped with zero historical rows) returns 0 legitimately", async () => {
		const t = createT();

		const result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-empty-ready-docs",
			scope: "empty-ready-scope",
		});
		expect(result).toEqual({ done: true, processed: 0, total: 0, cursor: "" });

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-empty-ready-docs",
			scope: "empty-ready-scope",
		});
		expect(count).toBe(0);
	});

	test("mid-bootstrap: countDocuments throws while status is still bootstrapping (partial walk, not yet done)", async () => {
		const t = createT();
		const N = 60;
		await seedHistoricalDocuments(t, "org-partial-docs", "partial-scope", N);

		const partial = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-partial-docs",
			scope: "partial-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-partial-docs",
				scope: "partial-scope",
			}),
			"scope_bootstrap_in_progress",
			"org-partial-docs",
			"partial-scope",
		);
	});

	test("interrupted then resumed bootstrap — stops before done, countDocuments throws in the interval, resuming reaches exact total with no double-count and no loss", async () => {
		const t = createT();
		const N = 97;
		await seedHistoricalDocuments(t, "org-resume-docs", "resume-scope", N);

		// First call only — deliberately NOT looped to completion.
		const interrupted = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-resume-docs",
			scope: "resume-scope",
			pageSize: 20,
		});
		expect(interrupted.done).toBe(false);
		expect(interrupted.total).toBeLessThan(N);

		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-resume-docs",
				scope: "resume-scope",
			}),
			"scope_bootstrap_in_progress",
			"org-resume-docs",
			"resume-scope",
		);

		// Resume to completion.
		let result = interrupted;
		let iterations = 1;
		while (!result.done) {
			result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
				orgId: "org-resume-docs",
				scope: "resume-scope",
				pageSize: 20,
			});
			iterations += 1;
			if (iterations > 100) throw new Error("resume loop did not converge");
		}

		expect(result.total).toBe(N);
		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-resume-docs",
			scope: "resume-scope",
		});
		expect(count).toBe(N);
	});

	test("insertDocuments refuses a write to a bootstrapping scope — write-race class closed, not merely documented", async () => {
		const t = createT();
		const N = 30;
		await seedHistoricalDocuments(t, "org-race-docs", "race-scope", N);

		const partial = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-race-docs",
			scope: "race-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "org-race-docs",
				scope: "race-scope",
				documents: [
					{
						document_id: "race-new",
						text: "Racing an in-progress bootstrap.",
					},
				],
			}),
			"write_refused_bootstrapping",
			"org-race-docs",
			"race-scope",
		);
	});

	test("deleteDocument refuses a delete on a bootstrapping scope", async () => {
		const t = createT();
		const N = 30;
		await seedHistoricalDocuments(t, "org-race-del-docs", "race-del-scope", N);

		const partial = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-race-del-docs",
			scope: "race-del-scope",
			pageSize: 10,
		});
		expect(partial.done).toBe(false);

		await expectRefusal(
			t.mutation(api.documentsV1.deleteDocument, {
				orgId: "org-race-del-docs",
				scope: "race-del-scope",
				document_id: "hist-doc-00000",
			}),
			"write_refused_bootstrapping",
			"org-race-del-docs",
			"race-del-scope",
		);
	});

	test("insertDocuments on a ready scope passes and increments normally", async () => {
		const t = createT();
		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-ready-write-docs",
			scope: "ready-write-scope",
			documents: [
				{
					document_id: "seed-1",
					text: "Seeds a ready scope.",
				},
			],
		});

		await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-ready-write-docs",
			scope: "ready-write-scope",
			documents: [
				{
					document_id: "seed-2",
					text: "Second write to an already-ready scope.",
				},
			],
		});

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-ready-write-docs",
			scope: "ready-write-scope",
		});
		expect(count).toBe(2);
	});

	test("ETA-PROBE2: a scope with N=10 pre-existing (historical, un-bootstrapped) rows THROWS on the first insertDocuments call — never a false ready-1", async () => {
		const t = createT();
		await seedHistoricalDocuments(t, "org-eta-probe2-docs", "eta-probe2-scope", 10);

		await expectRefusal(
			t.mutation(api.documentsV1.insertDocuments, {
				orgId: "org-eta-probe2-docs",
				scope: "eta-probe2-scope",
				documents: [
					{
						document_id: "eta-probe2-new",
						text: "First live write onto a historical, un-bootstrapped scope.",
					},
				],
			}),
			"scope_has_unmeasured_rows",
			"org-eta-probe2-docs",
			"eta-probe2-scope",
		);

		// countDocuments still throws — no false-ready-1 was ever stamped.
		await expectRefusal(
			t.query(api.documentsV1.countDocuments, {
				orgId: "org-eta-probe2-docs",
				scope: "eta-probe2-scope",
			}),
			"scope_not_initialized",
			"org-eta-probe2-docs",
			"eta-probe2-scope",
		);

		// Bootstrap is required and, once run to completion, is authoritative
		// at N=10 (the historical rows) — the refused insert never landed.
		let result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
			orgId: "org-eta-probe2-docs",
			scope: "eta-probe2-scope",
		});
		while (!result.done) {
			result = await t.mutation(api.documentsV1.bootstrapDocumentScopeCount, {
				orgId: "org-eta-probe2-docs",
				scope: "eta-probe2-scope",
			});
		}
		expect(result.total).toBe(10);

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-eta-probe2-docs",
			scope: "eta-probe2-scope",
		});
		expect(count).toBe(10);
	});

	test("fresh-scope order trap — two successive insertDocuments calls on a brand-new scope both pass; countDocuments returns the sum, no throw", async () => {
		const t = createT();

		const first = await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-order-trap-docs",
			scope: "order-trap-scope",
			documents: [
				{
					document_id: "trap-1",
					text: "First call on a scope that has never existed before.",
				},
			],
		});
		expect(first).toBe(1);

		const second = await t.mutation(api.documentsV1.insertDocuments, {
			orgId: "org-order-trap-docs",
			scope: "order-trap-scope",
			documents: [
				{
					document_id: "trap-2",
					text: "Second call — the scope is now ready.",
				},
			],
		});
		expect(second).toBe(1);

		const count = await t.query(api.documentsV1.countDocuments, {
			orgId: "org-order-trap-docs",
			scope: "order-trap-scope",
		});
		expect(count).toBe(2);
	});
});
