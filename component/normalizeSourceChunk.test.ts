import { describe, expect, test } from "vitest";
import { normalizeSourceChunk } from "./normalizeSourceChunk.js";

// component/normalizeSourceChunk.test.ts — ported from vantage-memory's
// convex/normalizeSourceChunk.test.ts (VP task k170j3b94dpfwxmrm2qxtwm5p18bqqjm,
// T2), field names renamed to this Component's camelCase convention
// (chunk_id -> chunkId, section_title -> sectionTitle, legal_references ->
// legalReferences, source_ref -> sourceRef). Assertions unchanged.
//
// RED-then-GREEN, pure unit (zero I/O, zero Convex runtime), against the
// REAL object shape emitted by vantage-paperasse's droit-du-travail
// `normalize_legi.py` / `normalize_kali.py` / `normalize_fiches_travail.py`
// (legalReferences: array of {code, article_id, article_cid, text};
// sourceRef: {pubId, url, repo, licence, date_maj}).

describe("normalizeSourceChunk — object legalReferences/sourceRef -> contract strings", () => {
	test("MUST_PASS: maps an object-shaped source chunk (legi/kali droit-du-travail shape) to the string contract", () => {
		const sourceChunk = {
			chunkId: "LEGIARTI000006901111",
			text: "Article L1234-1 : le contrat de travail a duree indeterminee peut etre rompu...",
			sectionTitle: null,
			legalReferences: [
				{
					code: "Code du travail",
					article_id: "LEGIARTI000006901111",
					article_cid: "LEGIARTI000006901111",
					text: "L1234-1",
				},
			],
			scope: "code-du-travail",
			sourceRef: {
				pubId: "LEGIARTI000006901111",
				url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006901111",
				repo: "SocialGouv/legi-data",
				licence: "Licence Ouverte 2.0",
				date_maj: "2017-09-24",
			},
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result.chunkId).toBe("LEGIARTI000006901111");
		expect(result.text).toBe(sourceChunk.text);
		expect(result.sectionTitle).toBeUndefined();
		expect(result.legalReferences).toEqual(["Code du travail L1234-1"]);
		expect(typeof result.legalReferences[0]).toBe("string");
		expect(result.sourceRef).toBe(
			"https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006901111",
		);
		expect(typeof result.sourceRef).toBe("string");
	});

	test("MUST_PASS: already-string legalReferences/sourceRef pass through unchanged", () => {
		const sourceChunk = {
			chunkId: "L1234-1_art1",
			text: "Article L1234-1 text.",
			sectionTitle: "Rupture du contrat",
			legalReferences: ["L1234-1"],
			sourceRef: "code-travail/L1234-1",
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result).toEqual(sourceChunk);
	});

	test("MUST_PASS: missing optional sectionTitle is preserved as undefined, never fabricated", () => {
		const sourceChunk = {
			chunkId: "id-1",
			text: "some text",
			legalReferences: [] as unknown[],
			sourceRef: "src/1",
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result.sectionTitle).toBeUndefined();
	});

	test("MUST_PASS: empty legalReferences array maps to an empty string array", () => {
		const sourceChunk = {
			chunkId: "id-2",
			text: "some text",
			legalReferences: [] as unknown[],
			sourceRef: { pubId: "p1", url: "https://example.org/p1", repo: "r", licence: "l" },
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result.legalReferences).toEqual([]);
		expect(result.sourceRef).toBe("https://example.org/p1");
	});

	test("MUST_PASS: object sourceRef without url falls back to pubId, never to a silent empty string", () => {
		const sourceChunk = {
			chunkId: "id-3",
			text: "some text",
			legalReferences: [],
			sourceRef: { pubId: "pub-only-id", repo: "r", licence: "l" },
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result.sourceRef).toBe("pub-only-id");
	});

	test("MUST_PASS: object legalReference missing code/text falls back to article_cid", () => {
		const sourceChunk = {
			chunkId: "id-4",
			text: "some text",
			legalReferences: [{ code: "", article_id: "a1", article_cid: "cid-4", text: "" }],
			sourceRef: "src/4",
		};

		const result = normalizeSourceChunk(sourceChunk);

		expect(result.legalReferences).toEqual(["cid-4"]);
	});

	test("MUST_REFUSE: an object sourceRef with neither url nor pubId throws, naming the missing instrument", () => {
		const sourceChunk = {
			chunkId: "id-5",
			text: "some text",
			legalReferences: [],
			sourceRef: { repo: "r", licence: "l" },
		};

		expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/sourceRef/);
	});

	test("MUST_REFUSE: an object legalReference with none of code/text/article_cid/article_id set throws, naming the missing instrument", () => {
		const sourceChunk = {
			chunkId: "id-6",
			text: "some text",
			legalReferences: [{ repo: "unrelated-field" }],
			sourceRef: "src/6",
		};

		expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/legalReferences/);
	});

	test("MUST_REFUSE: a legalReference entry that is neither a string nor an object throws", () => {
		const sourceChunk = {
			chunkId: "id-7",
			text: "some text",
			legalReferences: [42],
			sourceRef: "src/7",
		};

		expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/legalReferences/);
	});
});
