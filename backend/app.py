"""
AI Fitness Dataset Collection Platform
----------------------------------------
Flask backend that serves the data-collection flow (welcome -> form ->
live camera capture -> success) and exposes two JSON APIs used by the
browser during capture:

    POST /api/validate_pose   - checks a live preview frame for full-body
                                 visibility, framing, and lighting
    POST /api/capture_image   - saves a validated full-resolution frame

Storage is intentionally simple for a first prototype:
    dataset/participant_XXX/front.jpg | side.jpg | back.jpg
    fitness_dataset.csv               - one row per participant

NOTE: participant registration state is held in memory (PENDING) between
the form step and the finished capture. This is fine for a single
Flask process used by one research assistant at a time. For multi-user
or production deployments, replace PENDING with a real database/session
store.
"""

import base64
import csv
import os
import threading
from datetime import datetime

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, url_for

from pose_validation import validate_pose_frame

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATASET_DIR = os.path.join(PROJECT_ROOT, "dataset")
CSV_PATH = os.path.join(PROJECT_ROOT, "fitness_dataset.csv")
CSV_HEADERS = [
    "ID", "Gender", "Age", "Height_cm", "Weight_kg", "Fitness_Goal",
    "Front_Image", "Side_Image", "Back_Image", "Captured_At",
]
VIEW_ORDER = ["front", "side", "back"]

app = Flask(__name__, template_folder="../templates", static_folder="../static")

# In-memory record of participants who have registered but not yet
# finished capturing all three images. Guarded by a lock since Flask's
# dev server can handle requests on multiple threads.
_lock = threading.Lock()
PENDING = {}


def ensure_storage():
    os.makedirs(DATASET_DIR, exist_ok=True)
    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, "w", newline="") as f:
            csv.writer(f).writerow(CSV_HEADERS)


def next_participant_id():
    """Look at existing dataset folders + CSV rows to pick the next ID."""
    ensure_storage()
    existing = set()
    for name in os.listdir(DATASET_DIR):
        if name.startswith("participant_"):
            try:
                existing.add(int(name.split("_")[1]))
            except (IndexError, ValueError):
                pass
    with open(CSV_PATH, newline="") as f:
        for row in csv.DictReader(f):
            try:
                existing.add(int(row["ID"]))
            except (KeyError, ValueError):
                pass
    for pid in PENDING:
        existing.add(int(pid))
    next_id = (max(existing) + 1) if existing else 1
    return next_id


def participant_folder(participant_id):
    return os.path.join(DATASET_DIR, f"participant_{participant_id:03d}")


def decode_data_url(data_url):
    """Turn a 'data:image/jpeg;base64,...' string into raw bytes."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


# ---------------------------------------------------------------- pages ----

@app.route("/")
def welcome():
    return render_template("welcome.html")


@app.route("/form")
def form():
    return render_template("form.html")


@app.route("/register", methods=["POST"])
def register():
    gender = request.form.get("gender", "").strip()
    age = request.form.get("age", "").strip()
    height = request.form.get("height", "").strip()
    weight = request.form.get("weight", "").strip()
    fitness_goal = request.form.get("fitness_goal", "").strip()

    errors = []
    if gender not in ("Male", "Female", "Other"):
        errors.append("Select a gender/sex option.")
    for label, value in (("Age", age), ("Height", height), ("Weight", weight)):
        if not value:
            errors.append(f"{label} is required.")
        else:
            try:
                float(value)
            except ValueError:
                errors.append(f"{label} must be a number.")

    if errors:
        return render_template("form.html", errors=errors, values=request.form)

    with _lock:
        pid = next_participant_id()
        PENDING[pid] = {
            "gender": gender,
            "age": age,
            "height": height,
            "weight": weight,
            "fitness_goal": fitness_goal or "Not specified",
            "captured": {},
        }
    os.makedirs(participant_folder(pid), exist_ok=True)
    return redirect(url_for("capture", participant_id=pid))


@app.route("/capture/<int:participant_id>")
def capture(participant_id):
    record = PENDING.get(participant_id)
    if not record:
        return redirect(url_for("form"))
    captured_views = list(record["captured"].keys())
    return render_template(
        "capture.html",
        participant_id=f"{participant_id:03d}",
        raw_id=participant_id,
        view_order=VIEW_ORDER,
        captured_views=captured_views,
    )


@app.route("/success/<int:participant_id>")
def success(participant_id):
    display_id = f"{participant_id:03d}"
    folder = f"participant_{display_id}"
    return render_template(
        "success.html",
        participant_id=display_id,
        images=[f"/dataset/{folder}/{v}.jpg" for v in VIEW_ORDER],
    )


@app.route("/dataset/<path:filename>")
def serve_dataset_image(filename):
    return send_from_directory(DATASET_DIR, filename)


# ------------------------------------------------------------ JSON APIs ----

@app.route("/api/validate_pose", methods=["POST"])
def api_validate_pose():
    payload = request.get_json(silent=True) or {}
    view = payload.get("view", "front")
    image_data = payload.get("image")
    if not image_data:
        return jsonify({"ok": False, "messages": ["No frame received"]}), 400

    try:
        frame_bytes = decode_data_url(image_data)
    except Exception:
        return jsonify({"ok": False, "messages": ["Could not read frame"]}), 400

    result = validate_pose_frame(frame_bytes, view)
    return jsonify(result)


@app.route("/api/capture_image", methods=["POST"])
def api_capture_image():
    payload = request.get_json(silent=True) or {}
    participant_id = payload.get("participant_id")
    view = payload.get("view")
    image_data = payload.get("image")

    if view not in VIEW_ORDER:
        return jsonify({"success": False, "message": "Unknown view"}), 400
    try:
        pid = int(participant_id)
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Unknown participant"}), 400

    record = PENDING.get(pid)
    if not record:
        return jsonify({"success": False, "message": "Session expired, please register again"}), 400

    try:
        image_bytes = decode_data_url(image_data)
    except Exception:
        return jsonify({"success": False, "message": "Could not read image"}), 400

    folder = participant_folder(pid)
    os.makedirs(folder, exist_ok=True)
    file_path = os.path.join(folder, f"{view}.jpg")
    with open(file_path, "wb") as f:
        f.write(image_bytes)

    with _lock:
        record["captured"][view] = file_path

    remaining = [v for v in VIEW_ORDER if v not in record["captured"]]
    done = len(remaining) == 0

    if done:
        _finalize_participant(pid, record)

    return jsonify({
        "success": True,
        "done": done,
        "next_view": remaining[0] if remaining else None,
    })


def _finalize_participant(pid, record):
    ensure_storage()
    folder_name = f"participant_{pid:03d}"
    row = [
        f"{pid:03d}",
        record["gender"],
        record["age"],
        record["height"],
        record["weight"],
        record["fitness_goal"],
        f"{folder_name}/front.jpg",
        f"{folder_name}/side.jpg",
        f"{folder_name}/back.jpg",
        datetime.utcnow().isoformat(timespec="seconds") + "Z",
    ]
    with open(CSV_PATH, "a", newline="") as f:
        csv.writer(f).writerow(row)
    with _lock:
        PENDING.pop(pid, None)


if __name__ == "__main__":
    ensure_storage()
    app.run(debug=True, host="0.0.0.0", port=5000)
