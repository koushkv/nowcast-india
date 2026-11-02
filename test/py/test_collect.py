"""Collector test against a fake RainViewer (known storms encoded with the real colour table)."""
from __future__ import annotations

import io
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
import collect  # noqa: E402
from common import TILE, TX, TY, UNIVERSAL_BLUE, codes_to_rate, load_day, rgba_to_codes  # noqa: E402


def dbz_to_rgba(dbz: np.ndarray) -> np.ndarray:
    out = np.zeros(dbz.shape + (4,), dtype=np.uint8)
    for d, hexs in UNIVERSAL_BLUE:
        sel = (np.round(dbz) >= d) & ~np.isnan(dbz)
        out[sel] = [int(hexs[i:i + 2], 16) for i in (0, 2, 4, 6)]
    return out


class FakeResponse:
    def __init__(self, data=None, js=None, status=200):
        self.content, self._js, self.status_code = data, js, status

    def json(self):
        return self._js

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeRainViewer:
    def __init__(self, times):
        self.times = times
        self.calls = 0
        self.rate_limited_once = False

    def field(self, t):
        """A storm at a time-dependent position in native zoom-5 pixels (2048 x 1536)."""
        h, w = (TY[1] - TY[0]) * TILE, (TX[1] - TX[0]) * TILE
        yy, xx = np.mgrid[0:h, 0:w]
        cx = 600 + (t - self.times[0]) / 600 * 4
        d = 45 - 0.02 * ((xx - cx) ** 2 + (yy - 900) ** 2)
        d[d < 10] = np.nan
        return d

    def get(self, url, timeout=30):
        self.calls += 1
        if url.endswith("weather-maps.json"):
            return FakeResponse(js={"host": "https://tilecache.rainviewer.com", "radar": {"past": [{"time": t, "path": f"/v2/radar/{t}"} for t in self.times]}})
        if not self.rate_limited_once:  # exercise the 429 back-off once
            self.rate_limited_once = True
            return FakeResponse(status=429)
        parts = url.split("/")
        x, y = int(parts[-4]), int(parts[-3])
        if "/coverage/" in url:
            rgba = np.zeros((TILE, TILE, 4), dtype=np.uint8)
            if x == TX[0]:
                rgba[:, :100] = [0, 0, 0, 255]  # no radar on the far west
        else:
            t = int(parts[-7])
            f = self.field(t)
            i, j = x - TX[0], y - TY[0]
            rgba = dbz_to_rgba(f[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE])
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
        return FakeResponse(data=buf.getvalue())


def main():
    collect.MIN_GAP = 0.0
    collect.time.sleep = lambda s: None  # no real waiting in the test
    # palette round trip
    for d, hexs in UNIVERSAL_BLUE:
        rgba = np.array([[[int(hexs[i:i + 2], 16) for i in (0, 2, 4, 6)]]], dtype=np.uint8)
        assert int(rgba_to_codes(rgba)[0, 0]) == d + 40, d
    print("  ok  palette decodes every colour")

    times = [1793620800 + 600 * k for k in range(4)]
    fake = FakeRainViewer(times)
    f = collect.Fetcher(session=fake)
    with tempfile.TemporaryDirectory() as tmp:
        added = collect.main(["--dry-run", "--dir", tmp], fetcher=f)
        assert added == 4, added
        names = sorted(p.name for p in Path(tmp).iterdir())
        assert any(n.startswith("coverage-") for n in names) and any(n.startswith("radar-") for n in names), names
        ts, fr = load_day(Path(tmp) / [n for n in names if n.startswith("radar-")][0])
        assert ts == times and fr[0].shape == (1024, 768), (ts, fr[0].shape)
        # the storm centre (native 600, 900 -> grid 300, 450) is ~45 dBZ; it moves 2 grid px per frame
        c0 = int(fr[0][450, 300]) - 40
        c3 = int(fr[3][450, 306]) - 40
        assert 40 <= c0 <= 46 and 40 <= c3 <= 46, (c0, c3)
        rate = codes_to_rate(fr[0])
        assert rate[450, 300] > 10 and rate[100, 100] == 0
        print(f"  ok  4 frames archived, storm decoded at {c0} dBZ and tracked")
        # a second run finds nothing new and does not re-download frames
        calls = fake.calls
        assert collect.main(["--dry-run", "--dir", tmp], fetcher=f) == 0
        assert fake.calls == calls + 1  # only the index
        print("  ok  second run skips frames already archived")
        with np.load(Path(tmp) / [n for n in names if n.startswith("coverage-")][0]) as z:
            cov = z["coverage"]
        assert cov[:, :40].mean() < 0.1 and cov[:, 60:].mean() > 0.99
        print("  ok  coverage mask stored")

        # a day file that exists but can't be downloaded is left alone, never replaced by partial data
        day = [n for n in names if n.startswith("radar-")][0]
        fake.times = times + [times[-1] + 600, times[-1] + 1200]
        real_download = collect.ReleaseStore.download
        collect.ReleaseStore.download = lambda self, name: None
        try:
            assert collect.main(["--dry-run", "--dir", tmp], fetcher=f) == 0
        finally:
            collect.ReleaseStore.download = real_download
        assert load_day(Path(tmp) / day)[0] == times
        assert collect.main(["--dry-run", "--dir", tmp], fetcher=f) == 2
        assert load_day(Path(tmp) / day)[0] == fake.times
        print("  ok  an unreadable day file is never overwritten; the next run catches up")

        # old files are pruned so the release stays far below GitHub's asset limit
        collect.KEEP_DAYS = 2
        for n in ["radar-20200101.npz", "radar-20200102.npz", "coverage-20200101.npz", "coverage-20200102.npz", "coverage-20200103.npz"]:
            (Path(tmp) / n).write_bytes(b"x")
        collect.main(["--dry-run", "--dir", tmp], fetcher=f)
        left = sorted(p.name for p in Path(tmp).iterdir())
        assert "radar-20200101.npz" not in left and "radar-20200102.npz" in left and day in left, left
        assert "coverage-20200101.npz" not in left and sum(n.startswith("coverage-") for n in left) == 3, left
        print("  ok  old archive files are pruned")
    print("All collector tests passed")


if __name__ == "__main__":
    main()
