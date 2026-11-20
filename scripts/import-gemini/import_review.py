#!/usr/bin/env python3
"""Import checked items from a review file (data/review.md) into Memory Hub.

  python3 -I scripts/import-gemini/import_review.py data/review.md            # dry run: print the plan
  MCP_TOKEN=... python3 -I scripts/import-gemini/import_review.py data/review.md \
      --apply --url https://<worker>.workers.dev/mcp                          # actually import

Line formats (only `- [x]` lines are imported; `- [ ]` and everything else is ignored):
  - [x] profile: <key> = <value>
  - [x] [<category>/<importance>] <content> #tag #tag
Text after " — " is a reviewer note and is dropped. Saved with source=import:gemini-takeout.
Near-duplicates (status "similar") are NOT forced; they are listed for a manual decision.
"""
import json
import os
import re
import sys
import urllib.request

SOURCE = "import:gemini-takeout"
CATEGORIES = {"profile", "preference", "project", "decision", "knowledge", "todo"}
PROFILE = re.compile(r"^- \[x\]\s*(?:⚠️\s*)?profile:\s*([a-z0-9_]+)\s*=\s*(.+)$")
MEMORY = re.compile(r"^- \[x\]\s*(?:⚠️\s*)?\[(\w+)/([1-5])\]\s*(.+)$")


def parse(path: str):
    items = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip()
        text = line.split(" — ")[0]
        if m := PROFILE.match(text):
            items.append({"tool": "set_profile", "args": {"key": m[1], "value": m[2].strip()}, "line": n})
        elif m := MEMORY.match(text):
            category, importance, body = m[1], int(m[2]), m[3]
            if category not in CATEGORIES:
                sys.exit(f"line {n}: unknown category {category!r}")
            tags = re.findall(r"#(\S+)", body)
            content = re.sub(r"\s*#\S+", "", body).strip()
            items.append({"tool": "remember", "args": {"content": content, "category": category, "importance": importance, "tags": tags}, "line": n})
        elif line.startswith("- [x]"):
            sys.exit(f"line {n}: checked but not in a known format: {line[:80]}")
    return items


def call(url: str, token: str, name: str, args: dict, rid: int) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": name, "arguments": {**args, "source": SOURCE}}}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
    })
    raw = urllib.request.urlopen(req, timeout=60).read().decode()
    line = next((l[5:] for l in raw.splitlines() if l.startswith("data:")), raw)
    msg = json.loads(line)
    if "error" in msg:
        raise RuntimeError(msg["error"])
    text = msg["result"]["content"][0]["text"]
    if msg["result"].get("isError"):
        raise RuntimeError(text)
    return json.loads(text)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    items = parse(args[0])
    if "--apply" not in args:
        for i in items:
            print(f"L{i['line']:>3} {i['tool']:<11} {json.dumps(i['args'], ensure_ascii=False)}")
        print(f"\n{len(items)} items (dry run). Add --apply --url <mcp url> with MCP_TOKEN set to import.")
        return
    url = args[args.index("--url") + 1]
    token = os.environ.get("MCP_TOKEN") or sys.exit("MCP_TOKEN is not set")
    counts: dict[str, int] = {}
    for n, i in enumerate(items, 1):
        res = call(url, token, i["tool"], i["args"], n)
        status = res.get("status", "ok")
        counts[status] = counts.get(status, 0) + 1
        if status == "similar":
            cands = "; ".join(f"{c['id']} ({c['similarity']}) {c['content'][:40]}" for c in res["candidates"])
            print(f"L{i['line']} SIMILAR — decide manually: {i['args']['content'][:50]} ↔ {cands}")
        elif status == "duplicate":
            print(f"L{i['line']} duplicate of {res['existing']['id']}")
    print("done:", counts)


if __name__ == "__main__":
    main()
