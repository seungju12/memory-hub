#!/usr/bin/env python3
"""Keep only prompts likely to state facts about the user (first person, life, work),
and drop pasted logs/code. Usage: python3 -I filter.py data/work/conversations.jsonl data/work/self-prompts.md"""
import json
import re
import sys

SELF = re.compile(
    r"(^|[\s\"'(])(나는|나도|난 |내가|내 |내게|나한테|나의|저는|제가|제 |우리 |우리집|본가|여자친구|여친|남자친구|남친|엄마|아빠|부모님|할머니|"
    r"회사|직장|팀장|사수|출근|퇴근|프로젝트|자격증|시험|학점|연봉|월급|좋아해|좋아하는|싫어|취미|"
    r"운동|헬스|체중|키 |몸무게|피부|이사|청약|주식|투자|게임|오버워치|키보드|마우스|폰|갤럭시|노트북)"
)
LOGLIKE = re.compile(r"(\[root@|Error:|\bat [\w.$]+\(|^\s*[{<]|\d{4}/\d{2}/\d{2} \d{2}:|apiVersion:|kind: |\bINFO\b|\bWARN)", re.M)


def main(src: str, dst: str) -> None:
    kept = total = 0
    with open(dst, "w", encoding="utf-8") as out:
        for n, line in enumerate(open(src, encoding="utf-8"), 1):
            conv = json.loads(line)
            hits = []
            for t in conv["turns"]:
                total += 1
                p = re.sub(r"\s+", " ", t["prompt"]).strip()
                if len(p) > 600 or LOGLIKE.search(t["prompt"]) or not SELF.search(p):
                    continue
                hits.append(p)
            if hits:
                kept += len(hits)
                out.write(f"## C{n} {conv['start'][:10]}\n" + "".join(f"- {h}\n" for h in hits) + "\n")
    print(f"kept {kept}/{total} prompts -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
