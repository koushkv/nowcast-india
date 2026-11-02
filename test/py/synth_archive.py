"""Synthetic India radar archives (same format as backend/collect.py) for offline tests.

Storms move with a slowly turning steering wind, grow, mature and decay over 40-150 minutes, and new
ones keep appearing, so a model has something to learn beyond plain extrapolation."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from common import CODE_OFFSET, FRAME_STEP, H, W, day_name, rate_to_codes, save_day  # noqa: E402


def make(days: float, out: Path, start: int = 1793577600, seed: int = 1, cells_per_frame: float = 0.9) -> list[Path]:
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)
    n = int(days * 86400 / FRAME_STEP)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    storms = []
    by_day: dict[str, tuple[list, list]] = {}
    for k in range(n):
        t = start + k * FRAME_STEP
        ang = 0.6 * np.sin(2 * np.pi * k / 400.0)  # steering wind turns slowly
        u, v = 1.1 * np.cos(ang), 0.5 * np.sin(ang)  # pixels per frame (~5 km / 10 min)
        for _ in range(rng.poisson(cells_per_frame)):
            storms.append({"x": rng.uniform(0, W), "y": rng.uniform(0, H), "age": 0, "life": rng.integers(4, 15),
                           "r": rng.uniform(3, 9), "peak": rng.uniform(25, 55)})
        rate = np.zeros((H, W), dtype=np.float32)
        alive = []
        for s in storms:
            s["x"] += u + rng.normal(0, 0.1)
            s["y"] += v + rng.normal(0, 0.1)
            s["age"] += 1
            if s["age"] > s["life"] or not (-30 < s["x"] < W + 30 and -30 < s["y"] < H + 30):
                continue
            alive.append(s)
            phase = s["age"] / s["life"]
            dbz = s["peak"] * np.sin(np.pi * phase) ** 0.7  # grow, mature, decay
            r_peak = (10 ** (dbz / 10) / 200) ** (1 / 1.6)
            x0, x1 = int(max(0, s["x"] - 4 * s["r"])), int(min(W, s["x"] + 4 * s["r"]))
            y0, y1 = int(max(0, s["y"] - 4 * s["r"])), int(min(H, s["y"] + 4 * s["r"]))
            if x1 <= x0 or y1 <= y0:
                continue
            d2 = ((xx[y0:y1, x0:x1] - s["x"]) ** 2 + (yy[y0:y1, x0:x1] - s["y"]) ** 2) / s["r"] ** 2
            rate[y0:y1, x0:x1] = np.maximum(rate[y0:y1, x0:x1], r_peak * np.exp(-d2))
        storms = alive
        codes = rate_to_codes(rate)
        codes[(codes > 0) & (codes < CODE_OFFSET - 9)] = 0
        times, frames = by_day.setdefault(day_name(t), ([], []))
        times.append(t)
        frames.append(codes)
    paths = []
    for name, (times, frames) in by_day.items():
        p = out / name
        save_day(p, times, frames)
        paths.append(p)
    cov = np.ones((H, W), dtype=np.uint8)
    cov[:, :40] = 0  # an area without radar
    np.savez_compressed(out / ("coverage-" + day_name(start + (n - 1) * FRAME_STEP).split("-", 1)[1]), coverage=cov)
    return paths


if __name__ == "__main__":
    print(make(float(sys.argv[1]) if len(sys.argv) > 1 else 2.0, Path(sys.argv[2] if len(sys.argv) > 2 else "test/tmp-data")))
