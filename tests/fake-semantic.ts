import type { SemanticIndex, SemanticMatch } from "../src/search/semantic";

// Deterministic stand-in for bge-m3 + Vectorize. Texts that mention the same "concepts"
// get the same direction, so we can test meaning-based matches with zero keyword overlap.
const CONCEPTS: RegExp[] = [
	/김치찌개|된장찌개|한식|음식|메뉴|요리/, // food
	/typescript|타입스크립트|프로그래밍 언어|코딩/i, // programming
	/등산|산행|하이킹|트레킹/, // hiking
	/고양이|반려묘|냥이/, // cats
];

function fakeEmbed(text: string): number[] {
	const v = CONCEPTS.map((re) => (re.test(text) ? 1 : 0));
	// A little lexical noise so texts without concepts are not all-zero (and not identical).
	const noise = new Array<number>(8).fill(0);
	for (let i = 0; i < text.length - 1; i++) noise[(text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) % 8]! += 0.02;
	return [...v, ...noise];
}

function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! ** 2;
		nb += b[i]! ** 2;
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class FakeSemantic implements SemanticIndex {
	readonly vectors = new Map<string, { vector: number[]; category: string }>();
	failing = false;
	embedCalls = 0;

	async embed(texts: string[]) {
		this.embedCalls++;
		if (this.failing) throw new Error("AI unavailable");
		return texts.map(fakeEmbed);
	}
	async upsert(items: { id: string; vector: number[]; category: string }[]) {
		if (this.failing) throw new Error("Vectorize unavailable");
		for (const i of items) this.vectors.set(i.id, { vector: i.vector, category: i.category });
	}
	async query(vector: number[], { topK, category }: { topK: number; category?: string }): Promise<SemanticMatch[]> {
		if (this.failing) throw new Error("Vectorize unavailable");
		return [...this.vectors]
			.filter(([, v]) => !category || v.category === category)
			.map(([id, v]) => ({ id, score: cosine(vector, v.vector) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}
	async remove(ids: string[]) {
		for (const id of ids) this.vectors.delete(id);
	}
}
