#!/usr/bin/env python3
"""Gemini Takeout (My Activity JSON) -> conversations grouped by chat URL.

Usage: python3 -I scripts/import-gemini/parse.py <내활동.json> <out-dir>

Writes (into a gitignored data/ folder):
  conversations.jsonl  one conversation per line: {id, start, end, turns:[{time, prompt, answer_excerpt}]}
  prompts.md           compact, human/AI-readable list of the user's prompts per conversation,
                       which is what fact extraction reads (facts about the user live in prompts)
Run with `python3 -I` because the input is untrusted data.
"""
import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SUFFIXES = [" 항목을 검색함", "항목을 검색함"]
SKIP_TITLES = ("이전 의견을 삭제했습니다", "Gemini 앱 사용함")
TAG = re.compile(r"<[^>]+>")


def clean_prompt(title: str) -> str:
    t = title.strip()
    for s in SUFFIXES:
        if t.endswith(s):
            t = t[: -len(s)].rstrip()
    t = re.sub(r"^라이브 프롬프트\s*", "", t)
    return html.unescape(t)


def answer_text(entry: dict, limit: int) -> str:
    raw = " ".join(x.get("html", "") for x in entry.get("safeHtmlItem", []))
    text = html.unescape(TAG.sub(" ", raw))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def main(src: str, out_dir: str) -> None:
    entries = json.load(open(src, encoding="utf-8"))
    convs: dict[str, list] = defaultdict(list)
    for e in entries:
        title = e.get("title", "")
        if any(s in title for s in SKIP_TITLES):
            continue
        prompt = clean_prompt(title)
        if not prompt or prompt.startswith("<Automated"):
            continue
        urls = [d.get("url") for d in e.get("details", []) if d.get("url", "").startswith("https://gemini.google.com/")]
        cid = urls[0].rsplit("/", 1)[-1] if urls else f"single-{e['time']}"
        convs[cid].append({"time": e["time"], "prompt": prompt, "answer_excerpt": answer_text(e, 300)})

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ordered = sorted(convs.items(), key=lambda kv: min(t["time"] for t in kv[1]))
    with open(out / "conversations.jsonl", "w", encoding="utf-8") as f:
        for cid, turns in ordered:
            turns.sort(key=lambda t: t["time"])
            f.write(json.dumps({"id": cid, "start": turns[0]["time"], "end": turns[-1]["time"], "turns": turns}, ensure_ascii=False) + "\n")
    with open(out / "prompts.md", "w", encoding="utf-8") as f:
        for n, (cid, turns) in enumerate(ordered, 1):
            f.write(f"## C{n} {turns[0]['time'][:10]} ({len(turns)} turns)\n")
            for t in turns:
                p = re.sub(r"\s+", " ", t["prompt"])
                f.write(f"- {p[:400]}{'…' if len(p) > 400 else ''}\n")
            f.write("\n")
    total = sum(len(t) for t in convs.values())
    print(f"{len(convs)} conversations, {total} prompts -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
