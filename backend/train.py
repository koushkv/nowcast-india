"""Nightly training of the India radar nowcast model.

1. Downloads the last N days of radar archives (GitHub release assets written by collect.py).
2. Holds out the most recent day for validation; trains on the older days for a fixed time budget,
   continuing from the previous night's training run.
3. Scores the new model, the current live model and two radar baselines (persistence and motion
   extrapolation) on the held-out day with the Brier score for every lead time.
4. Publishes the new model to public/ai/ only if it beats the live model. metrics.json is always
   updated so the app knows how much to trust the model at each lead time.

Usage: python backend/train.py --release radar-data --dir data --out public/ai --minutes 50
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    FRAME_STEP, INPUT_FRAMES, LEADS, ReleaseStore, codes_to_input, load_day, log, rain_mask,
)

CROP = 128
N_OUT = len(LEADS) + 2


# ---------- data ----------
class Archive:
    def __init__(self, frames: dict[int, np.ndarray], coverage: np.ndarray | None):
        self.frames = frames
        h, w = next(iter(frames.values())).shape
        self.cov = coverage if coverage is not None else np.ones((h, w), dtype=np.uint8)
        self.h, self.w = h, w
        ts = set(frames)
        need_in = [-(INPUT_FRAMES - 1 - k) * FRAME_STEP for k in range(INPUT_FRAMES)]
        need_out = [k * FRAME_STEP for k in LEADS]
        self.samples = sorted(t for t in ts if all(t + d in ts for d in need_in + need_out))

    def example(self, t: int, y0: int, x0: int, rng: np.random.Generator | None = None):
        """Inputs (7, CROP, CROP), targets (14, CROP, CROP) and loss mask (1, CROP, CROP)."""
        sl = (slice(y0, y0 + CROP), slice(x0, x0 + CROP))
        xs = [codes_to_input(self.frames[t - (INPUT_FRAMES - 1 - k) * FRAME_STEP][sl]) for k in range(INPUT_FRAMES)]
        cov = self.cov[sl].astype(np.float32)
        x = np.stack(xs + [cov])
        ys = [rain_mask(self.frames[t + k * FRAME_STEP][sl]).astype(np.float32) for k in LEADS]
        y = np.stack(ys + [np.max(ys[:6], axis=0), np.max(ys[6:], axis=0)])
        m = cov[None]
        if rng is not None:  # flips / rotations: same physics, more variety while data is scarce
            k = int(rng.integers(4))
            flip = bool(rng.integers(2))
            x, y, m = (np.rot90(a, k, axes=(1, 2)) for a in (x, y, m))
            if flip:
                x, y, m = (a[:, :, ::-1] for a in (x, y, m))
            x, y, m = (np.ascontiguousarray(a) for a in (x, y, m))
        return x, y, m

    def pick_crop(self, t: int, rng: np.random.Generator) -> tuple[int, int]:
        """Mostly crops with rain in them (the interesting cases), sometimes anywhere covered."""
        if rng.random() < 0.75:
            rain = rain_mask(self.frames[t + 6 * FRAME_STEP]) | rain_mask(self.frames[t])
            ys, xs = np.nonzero(rain)
            if len(ys):
                i = int(rng.integers(len(ys)))
                y0 = int(np.clip(ys[i] - CROP // 2 + rng.integers(-32, 33), 0, self.h - CROP))
                x0 = int(np.clip(xs[i] - CROP // 2 + rng.integers(-32, 33), 0, self.w - CROP))
                return y0, x0
        for _ in range(20):
            y0, x0 = int(rng.integers(0, self.h - CROP + 1)), int(rng.integers(0, self.w - CROP + 1))
            if self.cov[y0:y0 + CROP, x0:x0 + CROP].mean() > 0.3:
                return y0, x0
        return int(rng.integers(0, self.h - CROP + 1)), int(rng.integers(0, self.w - CROP + 1))


def load_archives(store: ReleaseStore, days: int, older: int = 0, seed: int = 0) -> Archive | None:
    """The newest `days` daily files, plus `older` randomly chosen earlier ones (other seasons and
    weather regimes), so the model keeps learning from the whole archive with bounded memory."""
    names = [n for n in store.list() if n.startswith("radar-") and n.endswith(".npz")]
    recent, rest = names[-days:], names[:-days] if len(names) > days else []
    if older and rest:
        pick = np.random.default_rng(seed).choice(len(rest), size=min(older, len(rest)), replace=False)
        recent = sorted(rest[i] for i in pick) + recent
    names = recent
    frames: dict[int, np.ndarray] = {}
    for n in names:
        p = store.download(n)
        if not p:
            continue
        ts, fs = load_day(p)
        frames.update(zip(ts, fs))
        log(f"loaded {n}: {len(ts)} frames")
    if not frames:
        return None
    cov = None
    covs = [n for n in store.list() if n.startswith("coverage-")]
    if covs:
        p = store.download(covs[-1])
        if p:
            with np.load(p) as z:
                cov = z["coverage"]
    return Archive(frames, cov)


# ---------- baselines for validation ----------
def box_mean(a: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return a
    p = np.pad(a, r, mode="edge")
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    n = 2 * r + 1
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n * n)


def phase_shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Displacement (dy, dx) that moves a onto b, by phase correlation."""
    fa, fb = np.fft.fft2(a), np.fft.fft2(b)
    r = fb * np.conj(fa)
    r /= np.abs(r) + 1e-9
    c = np.fft.ifft2(r).real
    dy, dx = np.unravel_index(np.argmax(c), c.shape)
    h, w = a.shape
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    return float(dy), float(dx)


def shift(a: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.zeros_like(a)
    h, w = a.shape
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def baselines(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Persistence and motion-extrapolation chances for one example (from its input frames)."""
    latest = (x[INPUT_FRAMES - 1] >= (15 - 10) / 50).astype(np.float32)
    pers = np.repeat(latest[None], len(LEADS), 0)
    dy, dx = phase_shift(x[INPUT_FRAMES - 3], x[INPUT_FRAMES - 1])  # over 20 minutes
    vy, vx = dy / 2, dx / 2
    if abs(vy) > 12 or abs(vx) > 12:
        vy = vx = 0.0
    ext = []
    for k in LEADS:
        moved = shift(latest, int(round(vy * k)), int(round(vx * k)))
        ext.append(box_mean(moved, int(round(0.6 * k))))
    ext = np.stack(ext)
    add = lambda p: np.concatenate([p, p[:6].max(0, keepdims=True), p[6:].max(0, keepdims=True)])  # noqa: E731
    return add(pers), add(ext)


def brier(p: np.ndarray, y: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Per-channel Brier score over masked pixels."""
    w = m.sum() + 1e-9
    return ((p - y) ** 2 * m).sum(axis=(-1, -2)).reshape(-1, p.shape[-3]).sum(0) / w


# ---------- main ----------
def main(argv=None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", default="radar-data")
    ap.add_argument("--dir", default="data")
    ap.add_argument("--out", default="public/ai")
    ap.add_argument("--days", type=int, default=14, help="newest days of radar used")
    ap.add_argument("--older", type=int, default=14, help="plus this many randomly chosen older days")
    ap.add_argument("--minutes", type=float, default=50)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--val", type=int, default=240, help="validation examples")
    ap.add_argument("--min-train", type=int, default=300, help="training samples needed before the first model")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    import torch
    import torch.nn.functional as F

    from model import UNet, export, load_exported

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    store = ReleaseStore(args.release, Path(args.dir), dry_run=args.dry_run)
    metrics_path = out / "metrics.json"
    history = json.loads(metrics_path.read_text()).get("history", []) if metrics_path.exists() else []
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")

    def not_ready(status: dict, why: str) -> dict:
        """Before the first model: report progress. After it: keep the live model and its metrics."""
        prev = json.loads(metrics_path.read_text()) if metrics_path.exists() else {}
        if prev.get("status") == "ready" and (out / "model.json").exists():
            log(f"{why}; keeping the live model")
            return prev
        metrics_path.write_text(json.dumps(status, indent=1))
        log(why)
        return status

    try:
        arc = load_archives(store, args.days, args.older, seed=int(time.time() // 86400))
    except RuntimeError as e:  # archive not reachable (or not created yet)
        log(str(e))
        arc = None
    if arc is None or len(arc.samples) < 50:
        status = {"status": "collecting", "updated": now, "samples": 0 if arc is None else len(arc.samples), "history": history}
        return not_ready(status, "not enough radar data yet")

    # time split: the newest ~24 h are held out; training stops 2 h earlier so targets never overlap
    s = np.array(arc.samples)
    t_val = max(s[-1] - 24 * 3600, s[int(len(s) * 0.8)])
    val_t = s[s >= t_val]
    train_t = s[s < t_val - 2 * 3600]
    days = (s[-1] - s[0]) / 86400
    log(f"{len(s)} usable times over {days:.1f} days: {len(train_t)} train, {len(val_t)} validation")
    if len(train_t) < args.min_train:
        status = {"status": "collecting", "updated": now, "samples": int(len(s)), "trainSamples": int(len(train_t)),
                  "needed": args.min_train, "history": history}
        return not_ready(status, "collecting: not enough training samples yet")

    model = UNet()
    ckpt = store.download("model-latest.pt")
    if ckpt:
        try:
            model.load_state_dict(torch.load(ckpt, map_location="cpu"))
            log("continuing from the previous training run")
        except Exception as e:  # architecture changed: start fresh
            log(f"previous training run not usable ({e}); starting fresh")
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)

    # ---- train for the time budget ----
    budget = args.minutes * 60
    t0 = time.time()
    step, losses = 0, []
    model.train()
    while time.time() - t0 < budget:
        xb, yb, mb = [], [], []
        for _ in range(args.batch):
            t = int(train_t[rng.integers(len(train_t))])
            y0, x0 = arc.pick_crop(t, rng)
            x, y, m = arc.example(t, y0, x0, rng)
            xb.append(x); yb.append(y); mb.append(m)
        x = torch.from_numpy(np.stack(xb))
        y = torch.from_numpy(np.stack(yb))
        m = torch.from_numpy(np.stack(mb))
        frac = min(1.0, (time.time() - t0) / budget)
        for g in opt.param_groups:
            g["lr"] = 1e-4 + 0.5 * (1e-3 - 1e-4) * (1 + math.cos(math.pi * frac))
        logits = model(x)
        loss = (F.binary_cross_entropy_with_logits(logits, y, reduction="none") * m).sum() / (m.sum() * N_OUT + 1e-9)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
        losses.append(loss.item())
        step += 1
        if step % 50 == 0:
            log(f"step {step}: loss {np.mean(losses[-50:]):.4f}")
    log(f"trained {step} steps in {(time.time() - t0) / 60:.1f} min")

    # ---- validate ----
    vrng = np.random.default_rng(12345)
    exs = []
    for _ in range(args.val):
        t = int(val_t[vrng.integers(len(val_t))])
        y0, x0 = arc.pick_crop(t, vrng)
        exs.append(arc.example(t, y0, x0))
    live = None
    if (out / "model.json").exists() and (out / "model.bin").exists():
        try:
            live = load_exported(out / "model.json", out / "model.bin").eval()
        except Exception as e:
            log(f"live model not loadable ({e})")
    scores = {k: np.zeros(N_OUT) for k in ("ai", "live", "persistence", "extrapolation")}
    model.eval()
    with torch.no_grad():
        for x, y, m in exs:
            xt = torch.from_numpy(x[None])
            p_ai = torch.sigmoid(model(xt))[0].numpy()
            pers, ext = baselines(x)
            scores["ai"] += brier(p_ai, y, m)
            scores["persistence"] += brier(pers, y, m)
            scores["extrapolation"] += brier(ext, y, m)
            if live is not None:
                scores["live"] += brier(torch.sigmoid(live(xt))[0].numpy(), y, m)
    for k in scores:
        scores[k] /= len(exs)
    first12 = lambda k: float(scores[k][:len(LEADS)].mean())  # noqa: E731
    log("validation Brier (mean over leads): " + ", ".join(f"{k} {first12(k):.4f}" for k in scores if k != "live" or live is not None))

    promote = live is None or first12("ai") < first12("live")
    entry = {
        "date": now, "trainSamples": int(len(train_t)), "valExamples": len(exs), "steps": step, "days": round(days, 1),
        "brierAi": round(first12("ai"), 5), "brierLive": round(first12("live"), 5) if live is not None else None,
        "brierExtrapolation": round(first12("extrapolation"), 5), "promoted": bool(promote),
    }
    history = (history + [entry])[-60:]
    best = "ai" if promote else "live"
    metrics = {
        "status": "ready",
        "updated": now,
        "leadsMin": [10 * k for k in LEADS],
        "outputs": [f"+{10 * k} min" for k in LEADS] + ["any 0-60 min", "any 60-120 min"],
        "brier": {
            "model": [round(v, 5) for v in scores[best]],
            "extrapolation": [round(v, 5) for v in scores["extrapolation"]],
            "persistence": [round(v, 5) for v in scores["persistence"]],
        },
        "trainDays": round(days, 1),
        "trainSamples": int(len(train_t)),
        "history": history,
    }
    if promote:
        meta = {
            "version": datetime.now(timezone.utc).strftime("%Y%m%d%H%M"),
            "inputFrames": INPUT_FRAMES, "frameStepMin": FRAME_STEP // 60, "leadsMin": metrics["leadsMin"],
            "grid": {"zoom": 5, "tileSize": 256, "kmPerPx": 4.9}, "norm": {"dbzMin": 10, "dbzRange": 50},
            "rainDbz": 15, "metrics": {k: metrics[k] for k in ("brier", "trainDays", "trainSamples", "updated")},
        }
        export(model, out / "model.json", out / "model.bin", meta)
        log(f"published model {meta['version']}")
    else:
        log("kept the live model (new one was not better)")
    # Next night continues from tonight's weights, so learning builds up even on nights that aren't
    # published. A run that has drifted clearly below the live model restarts from the live model.
    ck = Path(args.dir) / "model-latest.pt"
    if not promote and first12("ai") > 1.05 * first12("live"):
        log("new model clearly worse than the live one: training restarts from the live model")
        torch.save(live.state_dict(), ck)
    else:
        torch.save(model.state_dict(), ck)
    store.upload(ck)
    metrics_path.write_text(json.dumps(metrics, indent=1))
    return metrics


if __name__ == "__main__":
    main()
