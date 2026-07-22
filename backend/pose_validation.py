"""
Pose validation using OpenCV + MediaPipe Pose.

Given a single JPEG frame from the live preview, this module checks
whether the frame is good enough to capture:

  - a full body is detected (key landmarks visible with confidence)
  - the person is not cropped by the frame edges
  - the person is roughly centered on the alignment point
  - the person is a reasonable distance from the camera (not too
    close / too far, based on how much of the frame height they fill)
  - the frame is bright enough to see detail
  - a loose check that the pose looks like the requested view
    (front/back have shoulders spread apart, side has them close together)

It returns a JSON-serializable dict:
    {
        "ok": bool,
        "messages": [str, ...],      # shown to the user, empty if ok
        "landmarks_detected": int,
        "checks": {...}              # raw booleans, useful for debugging
    }
"""

import cv2
import mediapipe as mp
import numpy as np

mp_pose = mp.solutions.pose

# One shared Pose instance reused across requests. static_image_mode=False
# lets MediaPipe use temporal smoothing across the steady stream of
# preview frames coming from a single camera session, which gives more
# stable landmarks than treating every frame as an isolated photo.
# NOTE: a single shared instance is not thread-safe for many concurrent
# users; for a multi-camera deployment, keep one Pose instance per
# session instead.
_pose = mp_pose.Pose(
    static_image_mode=False,
    model_complexity=0,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)

# Preview frames are downscaled to this max width before running Pose.
# Full-resolution frames aren't needed for the framing/lighting checks,
# and processing a smaller image uses far less memory and CPU per
# request -- important on memory-constrained free-tier hosting.
MAX_FRAME_WIDTH = 480

VISIBILITY_THRESHOLD = 0.5
KEY_LANDMARKS = {
    "nose": mp_pose.PoseLandmark.NOSE,
    "left_shoulder": mp_pose.PoseLandmark.LEFT_SHOULDER,
    "right_shoulder": mp_pose.PoseLandmark.RIGHT_SHOULDER,
    "left_hip": mp_pose.PoseLandmark.LEFT_HIP,
    "right_hip": mp_pose.PoseLandmark.RIGHT_HIP,
    "left_knee": mp_pose.PoseLandmark.LEFT_KNEE,
    "right_knee": mp_pose.PoseLandmark.RIGHT_KNEE,
    "left_ankle": mp_pose.PoseLandmark.LEFT_ANKLE,
    "right_ankle": mp_pose.PoseLandmark.RIGHT_ANKLE,
}
FULL_BODY_REQUIRED = [
    "left_shoulder", "right_shoulder", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]


def _decode_image(frame_bytes):
    arr = np.frombuffer(frame_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def validate_pose_frame(frame_bytes, view="front"):
    image = _decode_image(frame_bytes)
    if image is None:
        return {"ok": False, "messages": ["Could not read frame"], "landmarks_detected": 0, "checks": {}}

    height, width = image.shape[:2]
    if width > MAX_FRAME_WIDTH:
        scale = MAX_FRAME_WIDTH / width
        image = cv2.resize(image, (MAX_FRAME_WIDTH, int(height * scale)), interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    results = _pose.process(rgb)

    messages = []
    checks = {
        "person_detected": False,
        "full_body_visible": False,
        "inside_frame": False,
        "centered": False,
        "good_distance": False,
        "good_lighting": False,
        "matches_view": True,
    }

    # -- lighting check runs regardless of whether a person is found --
    brightness = float(np.mean(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)))
    checks["good_lighting"] = brightness >= 60
    if not checks["good_lighting"]:
        messages.append("Improve lighting")

    if not results.pose_landmarks:
        messages.insert(0, "Full body not detected")
        return {"ok": False, "messages": messages, "landmarks_detected": 0, "checks": checks}

    checks["person_detected"] = True
    landmarks = results.pose_landmarks.landmark
    visible = {
        name: landmarks[idx.value]
        for name, idx in KEY_LANDMARKS.items()
        if landmarks[idx.value].visibility >= VISIBILITY_THRESHOLD
    }
    landmarks_detected = len(visible)

    checks["full_body_visible"] = all(name in visible for name in FULL_BODY_REQUIRED)
    if not checks["full_body_visible"]:
        missing_lower = any(n in visible for n in ("left_shoulder", "right_shoulder")) and not all(
            n in visible for n in ("left_ankle", "right_ankle")
        )
        if missing_lower:
            messages.append("Move backward so your full body is visible")
        else:
            messages.append("Full body not detected")

    # Bounding box of all visible key landmarks, normalized 0-1.
    xs = [visible[n].x for n in visible]
    ys = [visible[n].y for n in visible]
    if xs and ys:
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        box_width = max_x - min_x
        box_height = max_y - min_y
        center_x = (min_x + max_x) / 2

        margin = 0.03
        checks["inside_frame"] = (
            min_x > margin and max_x < 1 - margin and min_y > margin and max_y < 1 - margin
        )
        if not checks["inside_frame"]:
            messages.append("Stand inside the frame")

        checks["centered"] = abs(center_x - 0.5) < 0.12
        if not checks["centered"]:
            messages.append("Move to center yourself on the alignment point")

        if box_height < 0.55:
            checks["good_distance"] = False
            messages.append("Move closer to the camera")
        elif box_height > 0.95:
            checks["good_distance"] = False
            messages.append("Move farther from the camera")
        else:
            checks["good_distance"] = True

        # Loose front/back vs side heuristic: a side profile collapses
        # shoulder width relative to hip-to-ankle body height.
        if "left_shoulder" in visible and "right_shoulder" in visible:
            shoulder_width = abs(visible["left_shoulder"].x - visible["right_shoulder"].x)
            relative_width = shoulder_width / box_height if box_height else 0
            if view == "side":
                checks["matches_view"] = relative_width < 0.22
                if not checks["matches_view"]:
                    messages.append("Turn to show your side profile")
            else:
                checks["matches_view"] = relative_width >= 0.22
                if not checks["matches_view"]:
                    messages.append("Face the camera directly" if view == "front" else "Turn your back to the camera")

    ok = all([
        checks["person_detected"],
        checks["full_body_visible"],
        checks["inside_frame"],
        checks["centered"],
        checks["good_distance"],
        checks["good_lighting"],
        checks["matches_view"],
    ])

    if ok:
        messages = []

    return {
        "ok": ok,
        "messages": messages,
        "landmarks_detected": landmarks_detected,
        "checks": checks,
    }
