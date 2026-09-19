#!/usr/bin/env python3
"""
Rewrite YuNet's input/output axes from static 640x640 to dynamic H/W.

The upstream opencv_zoo export of face_detection_yunet_2023mar pins the input
to [1,3,640,640] and every output to a fixed anchor count. Nothing in the graph
actually depends on that -- there are no baked-in spatial constants in any
Reshape or Resize -- so relaxing the declared dims lets us run at 320x192 for a
16:9 source instead of padding out to a 640 square. That is ~3x less work per
frame for identical results.

Run once; the result is vendored at resources/models/yunet.onnx.

    pip install onnx onnxruntime numpy
    python scripts/make-dynamic.py

Upstream source:
  https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
"""
import sys, hashlib, pathlib
import numpy as np
import onnx
import onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "resources/models/yunet_2023mar_upstream.onnx"
DST = ROOT / "resources/models/yunet.onnx"

CHANNELS = {"cls": 1, "obj": 1, "bbox": 4, "kps": 10}


def set_dims(value_info, dims):
    shape = value_info.type.tensor_type.shape
    del shape.dim[:]
    for d in dims:
        nd = shape.dim.add()
        if isinstance(d, str):
            nd.dim_param = d
        else:
            nd.dim_value = d


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC}\n  download the upstream export first")

    model = onnx.load(str(SRC))

    baked = []
    inits = {i.name: i for i in model.graph.initializer}
    for node in model.graph.node:
        if node.op_type in ("Reshape", "Resize", "Slice", "Expand"):
            for inp in node.input[1:]:
                if inp in inits:
                    arr = onnx.numpy_helper.to_array(inits[inp])
                    if arr.size and np.any(np.isin(arr, [640, 320, 6400, 1600, 400])):
                        baked.append((node.op_type, node.name, arr.tolist()))
    if baked:
        sys.exit(f"graph has baked-in spatial constants, cannot relax dims: {baked}")

    set_dims(model.graph.input[0], [1, 3, "H", "W"])
    for out in model.graph.output:
        kind, stride = out.name.split("_")
        set_dims(out, [1, f"N_{stride}", CHANNELS[kind]])
    model.graph.ClearField("value_info")  # stale inferred shapes

    onnx.checker.check_model(model)
    onnx.save(model, str(DST))

    # Prove it: every size we might ask for must produce the right anchor count.
    sess = ort.InferenceSession(str(DST), providers=["CPUExecutionProvider"])
    for h, w in [(320, 320), (320, 192), (192, 320), (256, 256), (288, 512), (640, 640)]:
        x = (np.random.rand(1, 3, h, w) * 255).astype(np.float32)
        outs = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {"input": x})))
        for s in (8, 16, 32):
            assert outs[f"cls_{s}"].shape == (1, (h // s) * (w // s), 1), (h, w, s)
        print(f"  {w}x{h} ok")

    digest = hashlib.sha256(DST.read_bytes()).hexdigest()
    print(f"\nwrote {DST.relative_to(ROOT)}  sha256={digest[:16]}...")


if __name__ == "__main__":
    main()
