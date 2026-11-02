"""Shared pieces of the India radar backend: grid geometry, RainViewer palette decoding,
archive files and GitHub-release storage.

Grid: all of India and its seas on Web Mercator zoom 5. RainViewer 512-px tiles x 22..24 and
y 12..15 (about 67.5-101 E, 0-41 N) are decoded and averaged 2x2 to ~4.9 km pixels, so one pixel
equals one zoom-5 world pixel of a 256-px tile. The browser builds the same grid from its own radar
tiles (mean of 4x4 pixels at zoom 6), which keeps training and inference consistent.
"""
from __future__ import annotations

import io
import json
import math
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

USER_AGENT = "india-nowcast-collector/1.0 (+https://weather.koushikv.site)"
ZOOM = 5
TILE = 512
TX = (22, 25)  # tile x range [22, 25)
TY = (12, 16)  # tile y range [12, 16)
GRID_X0 = TX[0] * 256  # zoom-5 world pixel of the grid's left edge (256-px tiles)
GRID_Y0 = TY[0] * 256
W = (TX[1] - TX[0]) * 256  # 768 px
H = (TY[1] - TY[0]) * 256  # 1024 px
CODE_OFFSET = 40  # stored value = round(dBZ) + 40; 0 = no echo
RAIN_DBZ = 15.0  # 0.3 mm/h, the forecast's rain threshold
FRAME_STEP = 600  # seconds between radar frames
INPUT_FRAMES = 6  # last hour (t-50 ... t)
LEADS = list(range(1, 13))  # +10 ... +120 min

# RainViewer "Universal Blue" (https://www.rainviewer.com/api/color-schemes.html), rain column.
UNIVERSAL_BLUE = [
    (-10, "63615914"), (-9, "66635a19"), (-8, "69665c1e"), (-7, "6c685d24"), (-6, "6f6b5f29"),
    (-5, "726e612e"), (-4, "75706234"), (-3, "78736439"), (-2, "7c75653e"), (-1, "7f786744"),
    (0, "827b6949"), (1, "857d6a4e"), (2, "88806c54"), (3, "8b826d59"), (4, "8e856f5e"),
    (5, "92887164"), (6, "9e93756e"), (7, "aa9e7978"), (8, "b6a97e82"), (9, "c2b4828c"),
    (10, "cec08796"), (11, "d2c48ba0"), (12, "d6c88faa"), (13, "dacc93b4"), (14, "ded097be"),
    (15, "88ddeeff"), (16, "6cd1ebff"), (17, "51c5e8ff"), (18, "36bae5ff"), (19, "1baee2ff"),
    (20, "00a3e0ff"), (21, "009ad5ff"), (22, "0091caff"), (23, "0088bfff"), (24, "007fb4ff"),
    (25, "0077aaff"), (26, "0070a3ff"), (27, "00699cff"), (28, "006295ff"), (29, "005b8eff"),
    (30, "005588ff"), (31, "005180ff"), (32, "004e78ff"), (33, "004a70ff"), (34, "004768ff"),
    (35, "ffee00ff"), (36, "ffe000ff"), (37, "ffd200ff"), (38, "ffc500ff"), (39, "ffb700ff"),
    (40, "ffaa00ff"), (41, "ff9f00ff"), (42, "ff9500ff"), (43, "ff8b00ff"), (44, "ff8100ff"),
    (45, "ff4400ff"), (46, "f23600ff"), (47, "e62800ff"), (48, "d91b00ff"), (49, "cd0d00ff"),
    (50, "c10000ff"), (51, "a80000ff"), (52, "8f0000ff"), (53, "760000ff"), (54, "5d0000ff"),
    (55, "ffaaffff"), (56, "ff9fffff"), (57, "ff95ffff"), (58, "ff8bffff"), (59, "ff81ffff"),
    (60, "ff77ffff"), (61, "ff6cffff"), (62, "ff62ffff"), (63, "ff58ffff"), (64, "ff4effff"),
    (66, "ffffffff"), (70, "00ff00ff"),
]


def _build_luts():
    alpha = np.full(256, -999, dtype=np.int16)
    semi = []
    opaque = {}
    for dbz, hexs in UNIVERSAL_BLUE:
        r, g, b, a = (int(hexs[i:i + 2], 16) for i in (0, 2, 4, 6))
        if a == 255:
            opaque[(r << 16) | (g << 8) | b] = dbz
        else:
            semi.append((a, dbz))
    for a in range(1, 255):
        alpha[a] = min(semi, key=lambda s: abs(s[0] - a))[1]
    return alpha, opaque


ALPHA_LUT, OPAQUE = _build_luts()
_OPAQUE_KEYS = np.array(sorted(OPAQUE), dtype=np.int64)
_OPAQUE_VALS = np.array([OPAQUE[k] for k in sorted(OPAQUE)], dtype=np.int16)


def rgba_to_codes(rgba: np.ndarray) -> np.ndarray:
    """RGBA image (h, w, 4 uint8) -> uint8 codes (dBZ + 40, 0 = no echo)."""
    a = rgba[..., 3].astype(np.int16)
    out = np.zeros(a.shape, dtype=np.int16)
    semi = (a > 0) & (a < 255)
    out[semi] = ALPHA_LUT[a[semi]]
    op = a == 255
    if op.any():
        key = (rgba[..., 0].astype(np.int64) << 16) | (rgba[..., 1].astype(np.int64) << 8) | rgba[..., 2].astype(np.int64)
        k = key[op]
        pos = np.searchsorted(_OPAQUE_KEYS, k)
        pos = np.clip(pos, 0, len(_OPAQUE_KEYS) - 1)
        found = _OPAQUE_KEYS[pos] == k
        vals = np.where(found, _OPAQUE_VALS[pos], -999)
        out[op] = vals
    codes = np.where(out == -999, 0, np.clip(out + CODE_OFFSET, 1, 255))
    codes[a == 0] = 0
    return codes.astype(np.uint8)


def codes_to_rate(codes: np.ndarray) -> np.ndarray:
    """uint8 codes -> rain rate mm/h (Marshall-Palmer)."""
    dbz = codes.astype(np.float32) - CODE_OFFSET
    rate = np.power(np.power(10.0, dbz / 10.0) / 200.0, 1 / 1.6)
    rate[(codes == 0) | (dbz <= 5)] = 0.0
    return rate.astype(np.float32)


def rate_to_codes(rate: np.ndarray) -> np.ndarray:
    out = np.zeros(rate.shape, dtype=np.uint8)
    ok = rate >= 0.05
    dbz = 10.0 * np.log10(200.0 * np.power(rate[ok], 1.6))
    out[ok] = np.clip(np.round(dbz) + CODE_OFFSET, 1, 255).astype(np.uint8)
    return out


def downsample2(codes: np.ndarray) -> np.ndarray:
    """2x2 mean in rain-rate space, back to codes (the same operation the browser does)."""
    r = codes_to_rate(codes)
    h, w = r.shape
    m = r.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    return rate_to_codes(m)


def codes_to_input(codes: np.ndarray) -> np.ndarray:
    """Model input scaling: (dBZ - 10) / 50 clipped to [0, 1]; 0 for no echo."""
    dbz = codes.astype(np.float32) - CODE_OFFSET
    x = np.clip((dbz - 10.0) / 50.0, 0.0, 1.0)
    x[codes == 0] = 0.0
    return x


def rain_mask(codes: np.ndarray) -> np.ndarray:
    return (codes.astype(np.int16) - CODE_OFFSET >= RAIN_DBZ) & (codes > 0)


# ---------- archives ----------
def day_name(t: int) -> str:
    return "radar-" + datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y%m%d") + ".npz"


def save_day(path: Path, times: list[int], frames: list[np.ndarray]) -> None:
    order = np.argsort(times)
    np.savez_compressed(path, times=np.asarray(times, dtype=np.int64)[order], frames=np.stack([frames[i] for i in order]).astype(np.uint8))


def load_day(path: Path) -> tuple[list[int], list[np.ndarray]]:
    with np.load(path) as z:
        return [int(t) for t in z["times"]], [f for f in z["frames"]]


# ---------- GitHub release storage (uses the gh CLI and GH_TOKEN in Actions) ----------
class ReleaseStore:
    """Files kept as assets of one GitHub release (no repository bloat, no extra account)."""

    def __init__(self, tag: str, local_dir: Path, dry_run: bool = False):
        self.tag = tag
        self.dir = Path(local_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.dry = dry_run

    def _gh(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(["gh", *args], check=check, capture_output=True, text=True)

    def ensure(self) -> None:
        if self.dry:
            return
        if self._gh("release", "view", self.tag, check=False).returncode != 0:
            self._gh("release", "create", self.tag, "--title", "India radar archive",
                     "--notes", "Radar frames collected for training the nowcast model.", "--latest=false")

    def list(self) -> list[str]:
        if self.dry:
            return sorted(p.name for p in self.dir.iterdir())
        r = self._gh("release", "view", self.tag, "--json", "assets", check=False)
        if r.returncode != 0:  # never treat a failed listing as an empty archive
            raise RuntimeError(f"cannot list release {self.tag}: {r.stderr.strip()}")
        return sorted(a["name"] for a in json.loads(r.stdout).get("assets", []))

    def download(self, name: str) -> Path | None:
        path = self.dir / name
        if self.dry:
            return path if path.exists() else None
        r = self._gh("release", "download", self.tag, "--pattern", name, "--dir", str(self.dir), "--clobber", check=False)
        return path if r.returncode == 0 and path.exists() else None

    def delete(self, name: str) -> None:
        if self.dry:
            (self.dir / name).unlink(missing_ok=True)
            return
        self._gh("release", "delete-asset", self.tag, name, "--yes", check=False)

    def upload(self, path: Path) -> None:
        if self.dry:
            return
        for attempt in range(3):
            r = self._gh("release", "upload", self.tag, str(path), "--clobber", check=False)
            if r.returncode == 0:
                return
            time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"upload failed: {r.stderr}")


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def lonlat_to_grid(lon: float, lat: float) -> tuple[float, float]:
    """Longitude/latitude -> grid pixel (x, y) of the India grid."""
    x = (lon + 180.0) / 360.0 * 256 * 2 ** ZOOM - GRID_X0
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 256 * 2 ** ZOOM - GRID_Y0
    return x, y


def png_to_rgba(data: bytes) -> np.ndarray:
    from PIL import Image  # imported lazily so training does not need Pillow

    img = Image.open(io.BytesIO(data)).convert("RGBA")
    return np.asarray(img, dtype=np.uint8)
