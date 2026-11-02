"""Collect India radar frames from RainViewer into daily archives (GitHub release assets).

Run every ~30 minutes. RainViewer keeps the last 2 hours of 10-minute frames, so a run catches up
on anything missed while the scheduler was late. Requests are throttled well under RainViewer's
100-requests-per-minute limit.

Usage: python backend/collect.py [--release radar-data] [--dir data] [--dry-run]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    TILE, TX, TY, USER_AGENT, ZOOM, ReleaseStore, day_name, downsample2, load_day, log, png_to_rgba,
    rgba_to_codes, save_day,
)

INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json"
MIN_GAP = 0.75  # seconds between tile requests (~80 per minute)
KEEP_DAYS = 450  # daily radar files kept in the release


class Fetcher:
    def __init__(self, session=None):
        if session is None:
            import requests

            session = requests.Session()
            session.headers["User-Agent"] = USER_AGENT
        self.s = session
        self.last = 0.0

    def get(self, url: str, binary: bool = False):
        for attempt in range(4):
            wait = MIN_GAP - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(url, timeout=30)
            except Exception as e:  # network hiccup
                log(f"  retry after error {e}")
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                log(f"  HTTP {r.status_code}, backing off")
                time.sleep(20 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.content if binary else r.json()
        raise RuntimeError(f"giving up on {url}")


def fetch_grid(f: Fetcher, base: str, suffix: str, decode) -> np.ndarray:
    """Assemble the 3x4 tiles of the India block and decode them (native zoom-5 / 512 px)."""
    nx, ny = TX[1] - TX[0], TY[1] - TY[0]
    out = np.zeros((ny * TILE, nx * TILE), dtype=np.uint8)
    for j in range(ny):
        for i in range(nx):
            url = f"{base}/{TILE}/{ZOOM}/{TX[0] + i}/{TY[0] + j}/{suffix}"
            rgba = png_to_rgba(f.get(url, binary=True))
            if rgba.shape[:2] != (TILE, TILE):
                raise RuntimeError(f"unexpected tile size {rgba.shape} for {url}")
            out[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE] = decode(rgba)
    return out


def coverage_from_rgba(rgba: np.ndarray) -> np.ndarray:
    dark = rgba[..., :3].astype(np.int32).sum(axis=2) < 120
    return np.where((rgba[..., 3] > 127) & dark, 0, 1).astype(np.uint8)


def main(argv=None, fetcher: Fetcher | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", default="radar-data")
    ap.add_argument("--dir", default="data")
    ap.add_argument("--dry-run", action="store_true", help="keep files locally, do not touch GitHub")
    args = ap.parse_args(argv)
    store = ReleaseStore(args.release, Path(args.dir), dry_run=args.dry_run)
    store.ensure()
    f = fetcher or Fetcher()

    index = f.get(INDEX_URL)
    host = index.get("host", "https://tilecache.rainviewer.com")
    frames = sorted(index.get("radar", {}).get("past", []), key=lambda fr: fr["time"])
    if not frames:
        log("no frames in the index")
        return 0
    assets = set(store.list())

    # coverage mask: refresh once a day
    cov_name = "coverage-" + day_name(frames[-1]["time"]).split("-", 1)[1]
    if cov_name not in assets:
        log("fetching coverage mask")
        cov = fetch_grid(f, f"{host}/v2/coverage/0", "0/0_0.png", coverage_from_rgba)
        h, w = cov.shape
        cov2 = (cov.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)) >= 0.5).astype(np.uint8)
        path = store.dir / cov_name
        np.savez_compressed(path, coverage=cov2)
        store.upload(path)

    by_day: dict[str, list[dict]] = {}
    for fr in frames:
        by_day.setdefault(day_name(fr["time"]), []).append(fr)
    added = 0
    for name, day_frames in by_day.items():
        times, grids = [], []
        if name in assets:
            p = store.download(name)
            if not p:  # do not overwrite a day we could not read; the next run catches up
                log(f"could not download {name}; skipping it this run")
                continue
            try:
                times, grids = load_day(p)
            except Exception as e:  # damaged file: start the day again
                log(f"{name} unreadable ({e}); starting it again")
        have = set(times)
        new = [fr for fr in day_frames if fr["time"] not in have]
        if not new:
            continue
        for fr in new:
            log(f"frame {fr['time']} -> {name}")
            try:
                native = fetch_grid(f, host + fr["path"], "2/0_0.png", rgba_to_codes)
            except Exception as e:  # one bad frame must not lose the others
                log(f"  skipped: {e}")
                continue
            times.append(int(fr["time"]))
            grids.append(downsample2(native))
            added += 1
        path = store.dir / name
        save_day(path, times, grids)
        store.upload(path)
        log(f"{name}: {len(times)} frames")
    prune(store, assets)
    log(f"done, {added} new frames")
    return added


def prune(store: ReleaseStore, assets: set[str]) -> None:
    """Stay far below GitHub's 1000 assets per release: keep 3 coverage masks and ~15 months of radar."""
    old = sorted(n for n in assets if n.startswith("coverage-"))[:-3]
    old += sorted(n for n in assets if n.startswith("radar-") and n.endswith(".npz"))[:-KEEP_DAYS]
    for n in old:
        log(f"removing old asset {n}")
        store.delete(n)


if __name__ == "__main__":
    main()
