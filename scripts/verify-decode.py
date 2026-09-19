#!/usr/bin/env python3
"""
Step 3 of the build order: prove src/worker/yunet.ts decodes YuNet correctly.

A wrong decode does not crash -- it produces plausible-looking boxes that are
slightly off, and you lose a day blaming the overlay maths. So we pin it to the
reference implementation: run cv2.FaceDetectorYN over a test image, dump the
raw ONNX tensors for the *same* input, and let scripts/verify-decode.mjs run
the real TypeScript decode over those tensors and diff the two.

    pip install onnx onnxruntime opencv-python-headless numpy
    python scripts/verify-decode.py && node scripts/verify-decode.mjs
"""
import json, pathlib, sys
import numpy as np
import cv2
import onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL = ROOT / "resources/models/yunet.onnx"
OUT = ROOT / "test/fixtures/decode-case.json"

CONF, NMS, TOPK = 0.6, 0.3, 500


def build_scene():
    """
    One face is not a test. Tile lena at several scales into a 512x288 canvas
    so the case exercises all three strides, multi-face NMS, and faces near the
    frame edge -- the places where an off-by-one in the anchor convention shows.
    """
    src = cv2.imread(str(ROOT / "test/fixtures/lena.jpg"))
    if src is None:
        sys.exit("missing test/fixtures/lena.jpg")
    canvas = np.full((288, 512, 3), 24, np.uint8)
    for x, y, size in [(10, 20, 220), (270, 40, 150), (400, 150, 96), (180, 170, 110)]:
        tile = cv2.resize(src, (size, size), interpolation=cv2.INTER_AREA)
        h = min(size, 288 - y)
        w = min(size, 512 - x)
        canvas[y : y + h, x : x + w] = tile[:h, :w]
    return canvas


def main():
    img = build_scene()
    h, w = img.shape[:2]
    assert h % 32 == 0 and w % 32 == 0, "input must sit on the stride grid"
    cv2.imwrite(str(ROOT / "test/fixtures/scene.png"), img)

    det = cv2.FaceDetectorYN_create(str(MODEL), "", (w, h), CONF, NMS, TOPK)
    _, faces = det.detect(img)
    faces = [] if faces is None else faces.tolist()
    print(f"OpenCV reference: {len(faces)} faces in {w}x{h}")

    # Exactly what §5.1 specifies: NCHW, BGR, [0,255], no normalisation.
    # cv2.imread already gives BGR, so this is a plain transpose.
    x = img.transpose(2, 0, 1)[None].astype(np.float32)

    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    names = [o.name for o in sess.get_outputs()]
    outs = dict(zip(names, sess.run(None, {"input": x})))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "inW": w,
                "inH": h,
                "conf": CONF,
                "nms": NMS,
                # OpenCV row: [x, y, w, h, 10 keypoint coords, score]
                "reference": [
                    {
                        "x": f[0], "y": f[1], "w": f[2], "h": f[3],
                        "pts": f[4:14], "score": f[14],
                    }
                    for f in faces
                ],
                "tensors": {k: np.asarray(v).ravel().round(6).tolist() for k, v in outs.items()},
            }
        )
    )
    # A small companion file the in-app self-test asserts against, without
    # dragging 950 KB of raw tensors into the renderer.
    expected = OUT.parent / "scene-expected.json"
    expected.write_text(
        json.dumps(
            {
                "width": w,
                "height": h,
                "faces": [
                    {"x": f[0], "y": f[1], "w": f[2], "h": f[3], "score": f[14]}
                    for f in faces
                ],
            },
            indent=2,
        )
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    print(f"wrote {expected.relative_to(ROOT)}")
    for f in faces:
        print(f"  box=({f[0]:7.2f},{f[1]:7.2f},{f[2]:6.2f},{f[3]:6.2f}) score={f[14]:.3f}")


if __name__ == "__main__":
    main()
