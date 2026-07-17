# AI Fitness Dataset Collection Platform

A web app for collecting a standardized image dataset (front / side / back,
full body) paired with self-reported height, weight, age, and gender — for
training later height/weight/body-analysis models.

## Folder structure

```
fitness-dataset-app/
├── backend/
│   ├── app.py                # Flask routes + page rendering + JSON APIs
│   ├── pose_validation.py    # OpenCV + MediaPipe Pose framing checks
│   └── requirements.txt
├── templates/
│   ├── base.html
│   ├── welcome.html           # Page 1 — welcome / start button
│   ├── form.html              # Page 2 — participant details form
│   ├── capture.html           # Page 3 — live camera capture
│   └── success.html           # Page 4 — success + participant ID
├── static/
│   ├── css/style.css
│   └── js/camera.js           # WebRTC preview, reticle, validation loop
├── dataset/                   # created automatically
│   └── participant_001/
│       ├── front.jpg
│       ├── side.jpg
│       └── back.jpg
└── fitness_dataset.csv        # created automatically
```

## CSV format

```
ID,Gender,Age,Height_cm,Weight_kg,Fitness_Goal,Front_Image,Side_Image,Back_Image,Captured_At
001,Female,21,160,55,Weight loss,participant_001/front.jpg,participant_001/side.jpg,participant_001/back.jpg,2026-07-10T12:00:00Z
```

## Setup

1. **Python 3.9–3.11** is recommended (MediaPipe wheels lag behind the
   newest Python releases).

2. Create a virtual environment and install dependencies:

   ```bash
   cd fitness-dataset-app/backend
   python -m venv venv
   source venv/bin/activate        # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Run the server:

   ```bash
   python app.py
   ```

4. Open `http://localhost:5000` in a browser. Camera access requires
   either `localhost` or HTTPS — browsers block `getUserMedia` on plain
   HTTP for any other host, so if you deploy this to a real server, put
   it behind HTTPS (e.g. via a reverse proxy with a TLS certificate).

## How capture validation works

Every ~900ms while the camera preview is open, the browser sends a
small preview frame to `POST /api/validate_pose`. The backend decodes
it and runs MediaPipe Pose over it, then checks:

- a body was detected at all
- shoulders, hips, knees, and ankles are all visible (full body, not cropped)
- the person's bounding box sits inside the frame margins
- the person is horizontally centered on the alignment point
- the person fills a reasonable portion of the frame height (not too
  close, not too far)
- overall brightness is high enough to see detail
- a loose heuristic for whether the pose matches the requested view
  (front/back have shoulders spread apart; side profile collapses them)

Only when every check passes does the browser automatically capture a
full-resolution frame and `POST` it to `/api/capture_image`, which
saves it to `dataset/participant_XXX/<view>.jpg`. Once all three views
are saved, the CSV row is written and the participant is redirected to
the success page.

## Known limitations (this is a first prototype)

- **In-memory participant state.** `PENDING` in `app.py` holds
  registrations that haven't finished capturing yet, in a plain Python
  dict. Restarting the server loses any in-progress (not yet fully
  captured) registrations. Swap this for a real database or Flask
  session store for production use.
- **Single shared MediaPipe Pose instance.** Fine for one participant
  being photographed at a time; if you need multiple simultaneous
  camera stations, give each session its own `Pose` instance.
- **Front vs. back detection is a heuristic.** MediaPipe's pose model
  can't see faces, so "front" vs "back" relies on shoulder geometry
  plus the on-screen instruction — it won't catch someone facing the
  wrong way while mimicking the expected shoulder width.
- **Consent and storage.** Before collecting real people's photos,
  make sure you have their informed consent for how the images will be
  stored and used, and that storage meets your local data protection
  requirements — this prototype stores images as plain JPEGs on disk.

## Next steps for the ML pipeline

The `dataset/` folder and `fitness_dataset.csv` are laid out so a
downstream training script can pair each row's `Height_cm` / `Weight_kg`
with its three image paths for:

- height estimation
- weight estimation
- body shape / posture analysis
- BMI prediction
- a fitness recommendation system
