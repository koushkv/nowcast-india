"""Build nowcast-india.zip: the whole project, ready to upload to GitHub (and deploy with Vercel).
Files sit at the top level of the zip (no wrapping folder)."""
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"node_modules", ".git", "data", "__pycache__", "shots", ".vercel"}
SKIP_PREFIX = ("test/tmp-",)


def wanted(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in SKIP_DIRS for p in parts[:-1]) or rel.startswith(SKIP_PREFIX):
        return False
    return not (rel.endswith(".zip") or rel.endswith(".pyc") or rel == "package-lock.json")


def main(out: str = "nowcast-india.zip") -> None:
    path = ROOT / out
    path.unlink(missing_ok=True)
    n = 0
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for f in filenames:
                full = Path(dirpath) / f
                rel = full.relative_to(ROOT).as_posix()
                if wanted(rel):
                    z.write(full, rel)
                    n += 1
    ai = [x for x in zipfile.ZipFile(path).namelist() if x.startswith("public/ai/")]
    assert ai == ["public/ai/metrics.json"], f"unexpected AI files in package: {ai}"
    print(f"{path.name}: {n} files, {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(*sys.argv[1:])
