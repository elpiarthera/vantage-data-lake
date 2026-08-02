// component/normalizeSourceChunk.ts — PURE mapping from a domain source chunk
// (which may carry OBJECT-shaped `legalReferences`/`sourceRef`, as emitted by
// e.g. vantage-paperasse's droit-du-travail normalize_legi.py /
// normalize_kali.py / normalize_fiches_travail.py pipelines) to the data-lake
// `chunksV1.insertChunks` contract shape (component/chunksV1.ts), whose
// `legal_references`/`source_ref` are STRINGS.
//
// Ported from vantage-memory's convex/normalizeSourceChunk.ts (VP task
// k170j3b94dpfwxmrm2qxtwm5p18bqqjm, T2 — data-lake chunk namespace), then
// reconciled in T3 (k170v3p0sxty10jv8ba9vg45x18bpbeq): the OUTPUT shape is
// now snake_case (chunk_id, section_title, legal_references, source_ref) to
// match chunksV1.insertChunks's byte-identical @vantageos/corpus contract.
// The INPUT `SourceChunk` type is UNCHANGED (still camelCase) — it
// represents the upstream domain pipeline's own field convention, a
// separate boundary from the data-lake contract this module maps onto.
// Logic is unchanged. Zero I/O, zero Convex import — a domain loader calls
// this before `chunksV1.insertChunks`, never after.
//
// Mapping contract:
//
//   legal_references: string[]
//     - a string entry passes through unchanged.
//     - an object entry {code, article_id, article_cid, text} maps to the
//       human-readable citation `"${code} ${text}".trim()` when at least
//       one of `code`/`text` is non-empty; otherwise falls back to
//       `article_cid`, then `article_id`. An object with none of those
//       four fields non-empty is a malformed source chunk and is refused
//       loudly (never silently coerced to an empty string).
//
//   source_ref: string
//     - a string passes through unchanged.
//     - an object {pubId, url, repo, licence, date_maj} maps to `url` (the
//       canonical citable provenance link) when present, else `pubId`.
//       An object with neither `url` nor `pubId` is refused loudly.

export type NormalizedChunk = {
	chunk_id: string;
	text: string;
	section_title?: string;
	legal_references: string[];
	source_ref: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLegalReference(entry: unknown, index: number): string {
	if (typeof entry === "string") {
		return entry;
	}
	if (isRecord(entry)) {
		const code = typeof entry.code === "string" ? entry.code.trim() : "";
		const text = typeof entry.text === "string" ? entry.text.trim() : "";
		const combined = [code, text].filter((part) => part.length > 0).join(" ");
		if (combined.length > 0) {
			return combined;
		}
		if (typeof entry.article_cid === "string" && entry.article_cid.length > 0) {
			return entry.article_cid;
		}
		if (typeof entry.article_id === "string" && entry.article_id.length > 0) {
			return entry.article_id;
		}
		throw new Error(
			`legalReferences[${index}] is an object with none of code/text/article_cid/article_id set — cannot derive a citable string, refusing a silent empty string.`,
		);
	}
	throw new Error(
		`legalReferences[${index}] is neither a string nor an object — got ${typeof entry}, refusing an ambiguous coercion.`,
	);
}

function normalizeSourceRefValue(sourceRef: unknown): string {
	if (typeof sourceRef === "string") {
		return sourceRef;
	}
	if (isRecord(sourceRef)) {
		if (typeof sourceRef.url === "string" && sourceRef.url.length > 0) {
			return sourceRef.url;
		}
		if (typeof sourceRef.pubId === "string" && sourceRef.pubId.length > 0) {
			return sourceRef.pubId;
		}
		throw new Error(
			"sourceRef is an object with neither `url` nor `pubId` set — cannot derive a provenance string, refusing a silent empty string.",
		);
	}
	throw new Error(
		`sourceRef is neither a string nor an object — got ${typeof sourceRef}, refusing an ambiguous coercion.`,
	);
}

// The minimal shape a source chunk must carry to be normalizable. `unknown`
// on the two contract-divergent fields is deliberate — the whole point of
// this module is to accept either the string (already-contract) or object
// (raw source) shape on those two fields.
export type SourceChunk = {
	chunkId: string;
	text: string;
	sectionTitle?: string | null;
	legalReferences: unknown[];
	sourceRef: unknown;
};

export function normalizeSourceChunk(sourceChunk: SourceChunk): NormalizedChunk {
	const normalized: NormalizedChunk = {
		chunk_id: sourceChunk.chunkId,
		text: sourceChunk.text,
		legal_references: sourceChunk.legalReferences.map((entry, index) =>
			normalizeLegalReference(entry, index),
		),
		source_ref: normalizeSourceRefValue(sourceChunk.sourceRef),
	};
	if (typeof sourceChunk.sectionTitle === "string") {
		normalized.section_title = sourceChunk.sectionTitle;
	}
	return normalized;
}
