"""End-to-end trainer test on synthetic radar: trains, validates against baselines, exports the
browser model, warm-starts a second night, and writes a parity fixture for the JavaScript port."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth_archive  # noqa: E402
import train  # noqa: E402

MINUTES = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "test" / "tmp-ai"


def main():
    import torch

    from model import UNet, load_exported

    torch.set_num_threads(max(1, torch.get_num_threads()))
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp) / "data"
        synth_archive.make(2.6, data)
        OUT.mkdir(parents=True, exist_ok=True)
        for f in OUT.iterdir():
            f.unlink()
        args = ["--dry-run", "--dir", str(data), "--out", str(OUT), "--minutes", str(MINUTES), "--val", "80", "--min-train", "100", "--batch", "8"]
        m1 = train.main(args)
        assert m1["status"] == "ready", m1
        b = m1["brier"]
        ai, ext, pers = np.mean(b["model"][:12]), np.mean(b["extrapolation"][:12]), np.mean(b["persistence"][:12])
        print(f"  night 1: Brier model {ai:.4f}  extrapolation {ext:.4f}  persistence {pers:.4f}")
        assert ai < pers, "the model must beat persistence"
        assert (OUT / "model.json").exists() and (OUT / "model.bin").exists()
        man = json.loads((OUT / "model.json").read_text())
        assert man["arch"] == "unet-v1" and man["floats"] * 4 == (OUT / "model.bin").stat().st_size
        print(f"  ok  exported model {man['version']} ({man['floats']} weights)")

        # second night: continues from the first model; publishes only if better
        m2 = train.main(args[:6] + [str(MINUTES / 2)] + args[7:])
        assert len(m2["history"]) == 2, m2["history"]
        h = m2["history"][-1]
        print(f"  night 2: model {h['brierAi']:.4f} vs live {h['brierLive']:.4f} -> {'published' if h['promoted'] else 'kept live model'}")
        assert h["brierLive"] is not None

        # a night when the archive can't be read must keep the published model switched on
        m3 = train.main(["--dry-run", "--dir", str(Path(tmp) / "empty"), "--out", str(OUT), "--minutes", "0.1"])
        assert m3["status"] == "ready", m3
        assert json.loads((OUT / "metrics.json").read_text())["status"] == "ready"
        print("  ok  a night without data keeps the live model")

        # a training run that has drifted far below the live model restarts from the live model
        ck = data / "model-latest.pt"
        bad = UNet()
        with torch.no_grad():
            for prm in bad.parameters():
                prm.normal_(0, 0.5)
        torch.save(bad.state_dict(), ck)
        m4 = train.main(args[:6] + ["0.05"] + args[7:])
        assert not m4["history"][-1]["promoted"], m4["history"][-1]
        live = load_exported(OUT / "model.json", OUT / "model.bin")
        sd = torch.load(ck)
        assert all(torch.equal(sd[k], v) for k, v in live.state_dict().items()), "checkpoint reset to the live model"
        print("  ok  a drifted training run restarts from the live model")

        # parity fixture for public/js/ai.js
        model = load_exported(OUT / "model.json", OUT / "model.bin").eval()
        rng = np.random.default_rng(3)
        x = np.zeros((1, 7, 64, 64), dtype=np.float32)
        x[0, :6] = np.clip(rng.normal(0.25, 0.25, (6, 64, 64)), 0, 1) * (rng.random((6, 64, 64)) < 0.4)
        x[0, 6] = 1
        x[0, 6, :, :5] = 0
        with torch.no_grad():
            y = torch.sigmoid(model(torch.from_numpy(x))).numpy()
        x.astype("<f4").tofile(OUT / "fixture-in.bin")
        y.astype("<f4").tofile(OUT / "fixture-out.bin")
        print("  ok  parity fixture written")
    print("All trainer tests passed")


if __name__ == "__main__":
    main()
