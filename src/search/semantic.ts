// P2: semantic search. The core service layer only sees the `SemanticIndex` interface,
// so it runs (keyword-only) without Workers AI / Vectorize, and tests can plug in a fake.

export const EMBEDDING_MODEL = "@cf/baai/bge-m3"; // multilingual (Korean OK), 1024 dims
export const EMBEDDING_DIMENSIONS = 1024;

// Thresholds measured on real bge-m3 scores for Korean memories (2026-11-20):
//   paraphrase of the same fact ≈ 0.75 · related but different facts ≈ 0.54–0.61
//   relevant query → memory ≈ 0.53–0.60 · unrelated query top hit ≈ 0.47
// The architecture draft said 0.9 for duplicates, which bge-m3 never reaches for paraphrases.

/** At or above this a new memory is reported as "similar" instead of saved (false positives are cheap: allow_similar). */
export const DUPLICATE_THRESHOLD = 0.7;
/** Semantic recall hits below this are noise and are dropped. */
export const MIN_RELEVANCE = 0.5;

export interface SemanticMatch {
	id: string;
	/** Cosine similarity, -1..1 */
	score: number;
}

export interface SemanticIndex {
	embed(texts: string[]): Promise<number[][]>;
	upsert(items: { id: string; vector: number[]; category: string }[]): Promise<void>;
	query(vector: number[], options: { topK: number; category?: string }): Promise<SemanticMatch[]>;
	remove(ids: string[]): Promise<void>;
}

/** Text that gets embedded: tags carry useful context ("memory-hub", "OAuth"). */
export function embeddingText(content: string, tags: string[]): string {
	return tags.length ? `${content}\n#${tags.join(" #")}` : content;
}

/** Workers AI (bge-m3) + Vectorize. Returns null when the bindings are not configured. */
export function cloudflareSemanticIndex(env: Pick<Env, "AI" | "VECTORS">): SemanticIndex | null {
	if (!env.AI || !env.VECTORS) return null;
	const { AI: ai, VECTORS: index } = env;
	return {
		async embed(texts) {
			if (texts.length === 0) return [];
			const out = (await ai.run(EMBEDDING_MODEL, { text: texts, truncate_inputs: true })) as { data?: number[][] };
			if (!out.data || out.data.length !== texts.length) throw new Error("embedding: unexpected response shape");
			return out.data;
		},
		async upsert(items) {
			if (items.length === 0) return;
			await index.upsert(items.map((i) => ({ id: i.id, values: i.vector, metadata: { category: i.category } })));
		},
		async query(vector, { topK, category }) {
			const res = await index.query(vector, {
				topK,
				returnMetadata: "none",
				...(category ? { filter: { category } } : {}),
			});
			return res.matches.map((m) => ({ id: m.id, score: m.score }));
		},
		async remove(ids) {
			if (ids.length) await index.deleteByIds(ids);
		},
	};
}

/** Reciprocal Rank Fusion: merges ranked id lists without comparing their raw scores. */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
	const scores = new Map<string, number>();
	for (const list of lists) {
		list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
	}
	return scores;
}
