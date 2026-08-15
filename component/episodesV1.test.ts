/// <reference types="vite/client" />
/**
 * component/episodesV1.test.ts — REVISE follow-up on PR #12
 * (omega/structured-refusal-errors): the reviewer named
 * `component/episodesV1.ts:50` (storeEpisode's missing-embedding throw) as
 * a consumer-reachable refusal that still shipped as a plain `Error`. This
 * file proves the ConvexError conversion the same way chunksV1.test.ts /
 * documentsV1.test.ts proved theirs — the `expectRefusal` helper is
 * replicated here rather than imported (chunksV1.test.ts does not export
 * it; same per-file duplication pattern already used between the two
 * existing test files).
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
	code: string,
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
	expect(data).toMatchObject({ code });
}

describe("component/episodesV1.ts — storeEpisode refuses a missing embedding as structured ConvexError", () => {
	test("storeEpisode without `embedding` throws ConvexError with code=embedding_required — never a plain Error", async () => {
		const t = createT();

		await expectRefusal(
			t.mutation(api.episodesV1.storeEpisode, {
				namespace: "global",
				createdBy: "test-orchestrator",
				context: "A situation.",
				goal: "A goal.",
				action: "An action.",
				outcome: "An outcome.",
				insight: "An insight.",
				severity: "minor",
				// embedding intentionally omitted
			}),
			"embedding_required",
		);
	});
});
