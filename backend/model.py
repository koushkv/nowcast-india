"""Compact U-Net for radar nowcasting (about 390k parameters, 1.5 MB as float32).

Input  (7 channels): the last 6 radar frames (t-50 ... t, 10-minute steps) scaled to [0, 1], plus a
                     radar-coverage mask.
Output (14 channels, logits): chance of rain >= 0.3 mm/h at +10, +20, ... +120 min, then the chance
                     of rain at any time in 0-60 min and in 60-120 min.

The layer list is shared with the browser implementation (public/js/ai.js); keep them in sync.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

IN_CH = 7
OUT_CH = 14
ARCH = [
    ("enc1a", IN_CH, 16), ("enc1b", 16, 16),
    ("enc2a", 16, 32), ("enc2b", 32, 32),
    ("enc3a", 32, 64), ("enc3b", 64, 64),
    ("mida", 64, 96), ("midb", 96, 96),
    ("dec3a", 96 + 64, 64), ("dec3b", 64, 64),
    ("dec2a", 64 + 32, 32), ("dec2b", 32, 32),
    ("dec1a", 32 + 16, 16), ("dec1b", 16, 16),
]


class UNet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.convs = nn.ModuleDict({n: nn.Conv2d(i, o, 3, padding=1) for n, i, o in ARCH})
        self.head = nn.Conv2d(16, OUT_CH, 1)
        with torch.no_grad():  # start near the climatological chance of rain (~5 %)
            self.head.bias.fill_(-3.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        c, r = self.convs, F.relu
        up = lambda t: F.interpolate(t, scale_factor=2, mode="nearest")  # noqa: E731
        e1 = r(c["enc1b"](r(c["enc1a"](x))))
        e2 = r(c["enc2b"](r(c["enc2a"](F.max_pool2d(e1, 2)))))
        e3 = r(c["enc3b"](r(c["enc3a"](F.max_pool2d(e2, 2)))))
        m = r(c["midb"](r(c["mida"](F.max_pool2d(e3, 2)))))
        d3 = r(c["dec3b"](r(c["dec3a"](torch.cat([up(m), e3], 1)))))
        d2 = r(c["dec2b"](r(c["dec2a"](torch.cat([up(d3), e2], 1)))))
        d1 = r(c["dec1b"](r(c["dec1a"](torch.cat([up(d2), e1], 1)))))
        return self.head(d1)


def export(model: UNet, json_path, bin_path, meta: dict) -> None:
    """Weights -> flat float32 file + JSON manifest read by the browser."""
    import json

    import numpy as np

    layers, chunks, offset = [], [], 0
    sd = {k: v.detach().cpu().numpy().astype("<f4") for k, v in model.state_dict().items()}
    for name, cin, cout in ARCH + [("head", 16, OUT_CH)]:
        prefix = "head" if name == "head" else f"convs.{name}"
        w, b = sd[f"{prefix}.weight"], sd[f"{prefix}.bias"]
        layers.append({"name": name, "in": cin, "out": cout, "k": int(w.shape[-1]), "w": offset, "b": offset + w.size})
        chunks += [w.ravel(), b.ravel()]
        offset += w.size + b.size
    flat = np.concatenate(chunks).astype("<f4")
    flat.tofile(bin_path)
    manifest = {"arch": "unet-v1", "inChannels": IN_CH, "outChannels": OUT_CH, "floats": int(flat.size), "layers": layers, **meta}
    with open(json_path, "w") as fh:
        json.dump(manifest, fh, indent=1)


def load_exported(json_path, bin_path) -> UNet:
    """Rebuild a model from the exported files (used to compare against the live model)."""
    import json

    import numpy as np

    with open(json_path) as fh:
        man = json.load(fh)
    flat = np.fromfile(bin_path, dtype="<f4")
    model = UNet()
    sd = model.state_dict()
    for L in man["layers"]:
        prefix = "head" if L["name"] == "head" else f"convs.{L['name']}"
        wshape = sd[f"{prefix}.weight"].shape
        n = int(np.prod(wshape))
        sd[f"{prefix}.weight"] = torch.from_numpy(flat[L["w"]:L["w"] + n].reshape(wshape).copy())
        sd[f"{prefix}.bias"] = torch.from_numpy(flat[L["b"]:L["b"] + L["out"]].copy())
    model.load_state_dict(sd)
    return model
