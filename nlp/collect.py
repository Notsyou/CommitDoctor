"""
Collect commit messages from public GitHub repositories (Part 2: Data Acquisition).

Source: public GitHub repositories, read with a history-only clone
(git clone --bare --filter=tree:0: commit metadata, no source code).
Labels come from the Conventional Commits prefix the projects already use
("fix(core): ..." -> fix). The prefix is then REMOVED from the text, so the
classifier has to learn intent from the wording alone.

Privacy: only the commit subject line and repo name are kept. Author names,
emails, GitHub logins and SHAs are never written to disk; @mentions, emails and
URLs inside messages are masked by preprocess.scrub_pii().

Usage:  python collect.py            -> data/commits.csv
"""
import csv
import random
import subprocess
import tempfile
import re
from pathlib import Path

from preprocess import scrub_pii

REPOS = [
    "vuejs/core", "vitejs/vite", "angular/angular", "nestjs/nest",
    "TanStack/query", "conventional-changelog/commitlint",
    "nuxt/nuxt", "vitest-dev/vitest",
]
COMMITS_PER_REPO = 3000     # most recent N commits
PER_CLASS_CAP = 350         # keep classes roughly balanced

TYPE_TO_LABEL = {
    "feat": "feature", "feature": "feature",
    "fix": "fix", "bugfix": "fix", "hotfix": "fix",
    "docs": "docs", "doc": "docs",
    "refactor": "refactor", "perf": "refactor", "style": "refactor",
    "test": "test", "tests": "test",
    "chore": "chore", "build": "chore", "ci": "chore", "release": "chore", "deps": "chore",
}
# Dependency-bot messages (Renovate/Dependabot) are machine-written, not human
# language, and would make "chore" trivially easy; they are excluded.
BOT = re.compile(r"^(update|bump|upgrade)\b.*\bto v?\d+(\.\d+)*|^update (dependency|all non-major|devdependency)", re.I)
CC = re.compile(r"^(?P<type>[a-zA-Z]+)(?:\([^)]*\))?!?:\s*(?P<rest>.+)$")

OUT = Path(__file__).parent / "data" / "commits.csv"


def subjects(repo, workdir):
    path = Path(workdir) / repo.replace("/", "__")
    subprocess.run(["git", "clone", "-q", "--bare", "--filter=tree:0",
                    f"https://github.com/{repo}.git", str(path)], check=True)
    # %s = subject only. Author name/email are deliberately NOT requested.
    out = subprocess.run(["git", "-C", str(path), "log", f"-{COMMITS_PER_REPO}", "--no-merges",
                          "--format=%s"], check=True, capture_output=True, text=True).stdout
    return out.splitlines()


def main():
    rows, seen = [], set()
    with tempfile.TemporaryDirectory() as tmp:
        for repo in REPOS:
            n0 = len(rows)
            for subject in subjects(repo, tmp):
                m = CC.match(subject.strip())
                if not m:
                    continue
                label = TYPE_TO_LABEL.get(m["type"].lower())
                text = scrub_pii(m["rest"]).strip()
                if not label or BOT.search(text) or len(text) < 3 or text.lower() in seen:
                    continue
                seen.add(text.lower())
                rows.append({"repo": repo, "label": label, "text": text})
            print(f"  {repo}: +{len(rows) - n0}")
    # Balance: cap each class with a fixed seed so the dataset is reproducible.
    random.seed(42)
    random.shuffle(rows)
    counts, kept = {}, []
    for r in rows:
        if counts.get(r["label"], 0) < PER_CLASS_CAP:
            counts[r["label"]] = counts.get(r["label"], 0) + 1
            kept.append(r)
    rows = kept
    print("  per class:", counts)
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["repo", "label", "text"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {OUT}")


if __name__ == "__main__":
    main()
#testing comment just to see if commits are actually detected
#comment number 2