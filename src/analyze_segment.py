"""分析一个录像分段：运动强度 + 画面统计 + 抽取代表帧。结果 JSON 打到 stdout。"""

import json
import os
import sys

import cv2
import numpy as np


def main() -> None:
    segment = sys.argv[1]
    frames_dir = sys.argv[2]
    stem = os.path.splitext(os.path.basename(segment))[0]

    cap = cv2.VideoCapture(segment)
    if not cap.isOpened():
        print(json.dumps({"error": f"cannot open {segment}"}))
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 15
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    prev_gray = None
    ratios = []
    brightness_sum = 0.0
    color_sum = np.zeros(3)
    peak_ratio, peak_index = -1.0, 0
    kept = {}
    index = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (320, 180), interpolation=cv2.INTER_AREA)
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        brightness_sum += float(gray.mean())
        color_sum += small.reshape(-1, 3).mean(axis=0)
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray)
            ratio = float(np.count_nonzero(diff > 25)) / diff.size
            ratios.append(ratio)
            if ratio > peak_ratio:
                peak_ratio, peak_index = ratio, index
                kept["peak"] = frame.copy()
        if index == 0:
            kept["first"] = frame.copy()
        kept["last"] = frame.copy()
        prev_gray = gray
        index += 1

    cap.release()
    if index == 0:
        print(json.dumps({"error": "no frames"}))
        sys.exit(1)

    mid_index = index // 2
    cap = cv2.VideoCapture(segment)
    cap.set(cv2.CAP_PROP_POS_FRAMES, mid_index)
    ok, mid_frame = cap.read()
    cap.release()
    if ok:
        kept["mid"] = mid_frame

    ratios_arr = np.array(ratios) if ratios else np.zeros(1)
    motion_score = float(ratios_arr.mean())
    active_fraction = float(np.count_nonzero(ratios_arr > 0.01) / len(ratios_arr))
    motion = active_fraction > 0.15 and motion_score > 0.003

    windows = []
    start = None
    gap = 0
    for i, r in enumerate(ratios):
        if r > 0.01:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > int(0.6 * fps):
                windows.append((start, i - gap))
                start = None
    if start is not None:
        windows.append((start, len(ratios) - 1))
    pad = 0.5
    active_windows = [
        {"start": round(max(0.0, s / fps - pad), 2), "end": round(min(index / fps, (e + 1) / fps + pad), 2)}
        for s, e in windows
        if (e - s) / fps >= 0.4
    ]

    keyframes = []
    for label in ("peak", "mid"):
        if label in kept:
            out = os.path.join(frames_dir, f"{stem}_{label}.jpg")
            cv2.imwrite(out, kept[label], [cv2.IMWRITE_JPEG_QUALITY, 82])
            keyframes.append(out)

    mean_bgr = color_sum / index
    result = {
        "file": os.path.abspath(segment),
        "frames": index,
        "fps": round(fps, 2),
        "duration": round(index / fps, 2),
        "width": width,
        "height": height,
        "motion": bool(motion),
        "motionScore": round(motion_score, 5),
        "activeFraction": round(active_fraction, 3),
        "activeWindows": active_windows,
        "peakTime": round(peak_index / fps, 2),
        "brightness": round(brightness_sum / index, 1),
        "meanColor": "#%02x%02x%02x" % (int(mean_bgr[2]), int(mean_bgr[1]), int(mean_bgr[0])),
        "keyframes": keyframes,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()