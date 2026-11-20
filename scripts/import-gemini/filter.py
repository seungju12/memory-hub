#!/usr/bin/env python3
"""Keep only prompts likely to state facts about the user (first person, life, work),
and drop pasted logs/code.

Usage: python3 -I filter.py data/work/conversations.jsonl data/work/self-prompts.md [--keywords FILE]

Personal keywords (your name, company, people close to you…) catch prompts that name them
without "나는/내가". They are read from a local file — default data/filter-keywords.txt —
one keyword per line, `#` for comments. Keep that file out of git: data/ is gitignored.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_KEYWORDS = Path("data/filter-keywords.txt")

SELF = re.compile(
    r"(^|[\s\"'(])(나는|나도|난 |내가|내 |내게|나한테|나의|저는|제가|제 |우리 |우리집|본가|여자친구|여친|남자친구|남친|엄마|아빠|부모님|할머니|"
    r"회사|직장|팀장|사수|출근|퇴근|프로젝트|자격증|시험|학점|연봉|월급|좋아해|좋아하는|싫어|취미|"
    r"운동|헬스|체중|키 |몸무게|피부|이사|청약|주식|투자|게임|오버워치|키보드|마우스|폰|갤럭시|노트북)"
)
LOGLIKE = re.compile(r"(\[root@|Error:|\bat [\w.$]+\(|^\s*[{<]|\d{4}/\d{2}/\d{2} \d{2}:|apiVersion:|kind: |\bINFO\b|\bWARN)", re.M)


def load_keywords(path: Path, explicit: bool) -> list[str]:
    if not path.exists():
        if explicit:
            sys.exit(f"keywords file not found: {path}")
        return []
    # Personal keywords must never be committed to the public repo.
    tracked = subprocess.run(["git", "check-ignore", "-q", str(path)], capture_output=True).returncode == 1
    if tracked:
        print(f"WARNING: {path} is not gitignored — move it under data/ so it is never committed", file=sys.stderr)
    words = []
    for line in path.read_text(encoding="utf-8").splitlines():
        word = line.split("#", 1)[0].strip()
        if word:
            words.append(word)
    return words


def main(argv: list[str]) -> None:
    explicit = "--keywords" in argv
    kw_path = Path(argv[argv.index("--keywords") + 1]) if explicit else DEFAULT_KEYWORDS
    positional = [a for i, a in enumerate(argv) if a != "--keywords" and (i == 0 or argv[i - 1] != "--keywords")]
    if len(positional) != 2:
        sys.exit(__doc__)
    src, dst = positional
    personal = load_keywords(kw_path, explicit)

    kept = total = 0
    with open(dst, "w", encoding="utf-8") as out:
        for n, line in enumerate(open(src, encoding="utf-8"), 1):
            conv = json.loads(line)
            hits = []
            for t in conv["turns"]:
                total += 1
                p = re.sub(r"\s+", " ", t["prompt"]).strip()
                if len(p) > 600 or LOGLIKE.search(t["prompt"]):
                    continue
                # Personal keywords match as plain substrings (Korean names take particles: 민수는, 민수랑).
                if SELF.search(p) or any(k in p for k in personal):
                    hits.append(p)
            if hits:
                kept += len(hits)
                out.write(f"## C{n} {conv['start'][:10]}\n" + "".join(f"- {h}\n" for h in hits) + "\n")
    print(f"kept {kept}/{total} prompts ({len(personal)} personal keywords) -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1:])
