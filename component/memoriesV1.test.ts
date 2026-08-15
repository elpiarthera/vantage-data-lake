/// <reference types="vite/client" />
/**
 * component/memoriesV1.test.ts — REVISE follow-up on PR #12
 * (omega/structured-refusal-errors): the reviewer named three
 * consumer-reachable refusals in this file that still shipped as plain
 * `Error` — storeMemory (missing embedding), softDeleteMemory (id not
 * found), validateIds (cap exceeded). This file proves each ConvexError
 * conversion the same way chunksV1.test.ts / documentsV1.test.ts proved
 * theirs — `expectRefusal` is replicated here (chunksV1.test.ts does not
 * export it; same per-file duplication pattern already in use).
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

async function expectRefusal(
	promise: Promise<unknown>,
	expectedData: Record<string, unknown>,
): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	const convexError = caught as ConvexError<string>;
	// convex-test round-trips `.data` JSON-stringified exactly as a real
	// client would receive it — parsing here mirrors what a consumer does.
	const data =
		typeof convexError.data === "string"
			? JSON.parse(convexError.data)
			: convexError.data;
	expect(data).toMatchObject(expectedData);
}

describe("component/memoriesV1.ts — storeMemory refuses a missing embedding as structured ConvexError", () => {
	test("storeMemory without `embedding` throws ConvexError with code=embedding_required — never a plain Error", async () => {
		const t = createT();

		await expectRefusal(
			t.mutation(api.memoriesV1.storeMemory, {
				namespace: "global",
				type: "project",
				content: "A memory with no embedding.",
				createdBy: "test-orchestrator",
				// embedding intentionally omitted
			}),
			{ code: "embedding_required" },
		);
	});
});

describe("component/memoriesV1.ts — softDeleteMemory refuses an unknown id as structured ConvexError", () => {
	test("softDeleteMemory on a memoryId that does not exist throws ConvexError with code=memory_not_found + the offending id", async () => {
		const t = createT();

		// Insert then delete directly (bypassing storeMemory, so no embedding /
		// rag.add path is exercised) to obtain a well-typed but now-absent id.
		const deletedId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert("memories", {
				namespace: "global",
				type: "project",
				content: "Will be deleted.",
				createdBy: "test-orchestrator",
				relations: [],
				isLatest: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.delete(id);
			return id;
		});

		await expectRefusal(
			t.mutation(api.memoriesV1.softDeleteMemory, {
				memoryId: deletedId,
			}),
			{ code: "memory_not_found", id: deletedId },
		);
	});
});

describe("component/memoriesV1.ts — validateIds refuses a batch over the cap as structured ConvexError", () => {
	test("validateIds with > 100 ids throws ConvexError with code=too_many_ids + cap + got as DATA", async () => {
		const t = createT();
		const ids = Array.from({ length: 101 }, (_, i) => `fake-id-${i}`);

		await expectRefusal(
			t.query(api.memoriesV1.validateIds, { ids }),
			{ code: "too_many_ids", cap: 100, got: 101 },
		);
	});
});
