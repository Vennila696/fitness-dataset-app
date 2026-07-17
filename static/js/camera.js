/* =========================================================
 * FITNESS DATASET CAMERA
 *
 * Features:
 * - WebRTC live camera
 * - Front / Side / Back sequence
 * - Pose validation using Flask backend
 * - Automatic shutter
 * - Stable pose confirmation
 * - Capture countdown
 * - Automatic next-view navigation
 * - Robust permission handling, secure-context detection,
 *   camera availability checks, detailed error messages,
 *   browser compatibility shims, and automatic recovery
 * ========================================================= */

(() => {
  "use strict";

  // =========================================================
  // DOM ELEMENTS
  // =========================================================

  const section = document.querySelector(".capture");

  if (!section) {
    console.error("Capture section not found.");
    return;
  }

  const participantId =
    section.dataset.participantId;

  const viewOrder = section.dataset.viewOrder
    ? section.dataset.viewOrder
        .split(",")
        .map((view) => view.trim())
        .filter(Boolean)
    : ["front", "side", "back"];

  const alreadyCaptured = new Set(
    section.dataset.captured
      ? section.dataset.captured
          .split(",")
          .map((view) => view.trim())
          .filter(Boolean)
      : []
  );

  const video =
    document.getElementById("video");

  const overlay =
    document.getElementById("overlay");

  const captureCanvas =
    document.getElementById("capture-canvas");

  const instructions =
    document.getElementById("instructions");

  const currentViewLabel =
    document.getElementById(
      "current-view-label"
    );

  const sequenceList =
    document.getElementById(
      "sequence-list"
    );

  const checklist =
    document.getElementById("checklist");

  const guidanceText =
    document.getElementById(
      "guidance-text"
    );

  const captureBtn =
    document.getElementById(
      "capture-btn"
    );

  // =========================================================
  // ELEMENT VALIDATION
  // =========================================================

  const requiredElements = {
    video,
    overlay,
    captureCanvas,
    instructions,
    currentViewLabel,
    sequenceList,
    checklist,
    guidanceText,
    captureBtn,
  };

  for (
    const [name, element]
    of Object.entries(requiredElements)
  ) {
    if (!element) {
      console.error(
        `Required element missing: ${name}`
      );

      return;
    }
  }

  const overlayCtx =
    overlay.getContext("2d");

  // =========================================================
  // STATE
  // =========================================================

  let currentIndex =
    viewOrder.findIndex(
      (view) =>
        !alreadyCaptured.has(view)
    );

  if (currentIndex === -1) {
    currentIndex = 0;
  }

  let cameraStream = null;

  let validationInterval = null;

  let validating = false;

  let capturing = false;

  let lastValidationOk = false;

  // Number of continuous valid responses

  let stablePoseCount = 0;

  // Require 3 consecutive successful validations

  const REQUIRED_STABLE_CHECKS = 3;

  // Prevent multiple shutter triggers

  let autoShutterTriggered = false;

  // Camera lifecycle / recovery state

  let cameraStarting = false;

  let cameraRecoveryTimer = null;

  let cameraRecoveryAttempts = 0;

  const MAX_CAMERA_RECOVERY_ATTEMPTS = 5;

  const CAMERA_RECOVERY_BASE_DELAY_MS = 1500;

  let trackEndedHandlerAttached = false;

  let permissionStatusRef = null;

  // =========================================================
  // VIEW PROMPTS
  // =========================================================

  const VIEW_PROMPTS = {
    front:
      "Face the camera. Keep your full body visible and arms slightly away from your body.",

    side:
      "Turn 90 degrees. Keep your side facing the camera.",

    back:
      "Turn completely around. Keep your back facing the camera.",
  };

  // =========================================================
  // UPDATE UI
  // =========================================================

  function updateSequenceUI() {
    const currentView =
      viewOrder[currentIndex];

    sequenceList
      .querySelectorAll("li")
      .forEach((li) => {
        const view =
          li.dataset.view;

        li.classList.remove(
          "is-active",
          "is-done"
        );

        if (
          alreadyCaptured.has(view)
        ) {
          li.classList.add(
            "is-done"
          );
        }

        else if (
          view === currentView
        ) {
          li.classList.add(
            "is-active"
          );
        }
      });

    currentViewLabel.textContent =
      currentView.toUpperCase();

    captureBtn.textContent =
      `Auto capture ${currentView}`;

    captureBtn.disabled = true;

    guidanceText.textContent =
      VIEW_PROMPTS[currentView] || "";
  }

  // =========================================================
  // DRAW RETICLE
  // =========================================================

  function drawReticle() {
    const width =
      overlay.clientWidth;

    const height =
      overlay.clientHeight;

    if (!width || !height) {
      return;
    }

    overlay.width = width;

    overlay.height = height;

    overlayCtx.clearRect(
      0,
      0,
      width,
      height
    );

    const accent =
      lastValidationOk
        ? "#2f6f5e"
        : "#35608f";

    overlayCtx.strokeStyle =
      accent;

    overlayCtx.fillStyle =
      accent;

    overlayCtx.lineWidth = 2;

    // Full body guide

    const frameWidth =
      width * 0.56;

    const frameHeight =
      height * 0.82;

    const frameX =
      (width - frameWidth) / 2;

    const frameY =
      height * 0.06;

    const cornerSize = 22;

    const corners = [
      [
        frameX,
        frameY,
        1,
        1,
      ],

      [
        frameX + frameWidth,
        frameY,
        -1,
        1,
      ],

      [
        frameX,
        frameY + frameHeight,
        1,
        -1,
      ],

      [
        frameX + frameWidth,
        frameY + frameHeight,
        -1,
        -1,
      ],
    ];

    overlayCtx.beginPath();

    corners.forEach(
      ([
        cornerX,
        cornerY,
        directionX,
        directionY,
      ]) => {
        overlayCtx.moveTo(
          cornerX,
          cornerY +
            cornerSize *
              directionY
        );

        overlayCtx.lineTo(
          cornerX,
          cornerY
        );

        overlayCtx.lineTo(
          cornerX +
            cornerSize *
              directionX,
          cornerY
        );
      }
    );

    overlayCtx.stroke();

    // Center point

    const centerX =
      width / 2;

    const centerY =
      frameY +
      frameHeight * 0.42;

    overlayCtx.beginPath();

    overlayCtx.arc(
      centerX,
      centerY,
      5,
      0,
      Math.PI * 2
    );

    overlayCtx.fill();

    // Crosshair

    overlayCtx.beginPath();

    overlayCtx.moveTo(
      centerX - 16,
      centerY
    );

    overlayCtx.lineTo(
      centerX - 8,
      centerY
    );

    overlayCtx.moveTo(
      centerX + 8,
      centerY
    );

    overlayCtx.lineTo(
      centerX + 16,
      centerY
    );

    overlayCtx.moveTo(
      centerX,
      centerY - 16
    );

    overlayCtx.lineTo(
      centerX,
      centerY - 8
    );

    overlayCtx.moveTo(
      centerX,
      centerY + 8
    );

    overlayCtx.lineTo(
      centerX,
      centerY + 16
    );

    overlayCtx.stroke();
  }

  // =========================================================
  // BROWSER COMPATIBILITY SHIM
  //
  // Normalizes getUserMedia across older / vendor-prefixed
  // implementations so startCamera() can rely on a single,
  // modern promise-based API regardless of browser.
  // =========================================================

  function ensureGetUserMediaShim() {
    if (!navigator.mediaDevices) {
      navigator.mediaDevices = {};
    }

    if (!navigator.mediaDevices.getUserMedia) {
      const legacyGetUserMedia =
        navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia ||
        navigator.msGetUserMedia;

      if (legacyGetUserMedia) {
        navigator.mediaDevices.getUserMedia =
          function (constraints) {
            return new Promise(
              (resolve, reject) => {
                legacyGetUserMedia.call(
                  navigator,
                  constraints,
                  resolve,
                  reject
                );
              }
            );
          };
      }
    }
  }

  // =========================================================
  // SECURE CONTEXT CHECK
  //
  // getUserMedia is only available in secure contexts
  // (https, or localhost / 127.0.0.1 / file://). Detect this
  // early so we can show an actionable message instead of a
  // confusing "Camera API unavailable" error.
  // =========================================================

  function isSecureContextForCamera() {
    if (
      typeof window.isSecureContext ===
      "boolean"
    ) {
      if (window.isSecureContext) {
        return true;
      }
    }

    const hostname =
      window.location.hostname;

    const protocol =
      window.location.protocol;

    if (protocol === "https:") {
      return true;
    }

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return true;
    }

    return false;
  }

  // =========================================================
  // CAMERA AVAILABILITY CHECK
  //
  // Uses enumerateDevices (when available) to confirm at
  // least one videoinput exists before requesting a stream.
  // Labels are typically blank until permission is granted,
  // so this is a best-effort pre-check, not a guarantee.
  // =========================================================

  async function hasVideoInputDevice() {
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.enumerateDevices
    ) {
      // Can't verify; assume a camera might exist and let
      // getUserMedia be the source of truth.
      return true;
    }

    try {
      const devices =
        await navigator.mediaDevices.enumerateDevices();

      return devices.some(
        (device) =>
          device.kind === "videoinput"
      );
    } catch (error) {
      console.warn(
        "Unable to enumerate devices:",
        error
      );

      return true;
    }
  }

  // =========================================================
  // PERMISSION STATE MONITORING
  //
  // Where supported, watches the Permissions API so that if
  // the user revokes camera access mid-session (or grants it
  // after an initial denial), we react automatically instead
  // of requiring a page reload.
  // =========================================================

  async function watchCameraPermission() {
    if (
      !navigator.permissions ||
      !navigator.permissions.query
    ) {
      return;
    }

    try {
      const status =
        await navigator.permissions.query({
          name: "camera",
        });

      permissionStatusRef = status;

      status.onchange = () => {
        console.log(
          "Camera permission changed:",
          status.state
        );

        if (
          status.state === "granted" &&
          !cameraStream &&
          !cameraStarting
        ) {
          instructions.textContent =
            "Camera permission granted — reconnecting...";

          scheduleCameraRecovery(true);
        }

        else if (status.state === "denied") {
          stopValidationLoop();

          stopCamera();

          captureBtn.disabled = true;

          instructions.textContent =
            "Camera permission denied. Allow camera access in your browser settings and reload the page.";
        }
      };
    } catch (error) {
      // Permissions API may not support the "camera" name in
      // some browsers (e.g. Firefox). This is non-fatal.
      console.warn(
        "Camera permission query unsupported:",
        error
      );
    }
  }

  // =========================================================
  // ERROR MESSAGE RESOLUTION
  //
  // Central place mapping getUserMedia / camera errors to
  // clear, actionable instructions for the participant.
  // =========================================================

  function describeCameraError(error) {
    const name =
      (error && error.name) || "";

    const message =
      (error && error.message) || "";

    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Camera permission denied. Allow camera access in your browser's site settings, then reload the page.";

      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No camera detected. Connect a camera or check that it isn't disabled, then reload the page.";

      case "NotReadableError":
      case "TrackStartError":
        return "Camera is busy or unreadable. Close other apps or browser tabs using the camera, then try again.";

      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        return "No camera meets the required settings. Trying a lower resolution automatically.";

      case "SecurityError":
        return "Camera access is blocked in this context. Load this page over HTTPS or from localhost.";

      case "AbortError":
        return "Camera initialization was interrupted. Retrying...";

      case "TypeError":
        return "Camera API misconfigured. Please reload the page.";

      default:
        return message
          ? `Camera error: ${message}`
          : "Unknown camera error. Please reload the page.";
    }
  }

  function isRecoverableCameraError(error) {
    const name =
      (error && error.name) || "";

    // Permission denial and total absence of hardware are
    // not recoverable by retrying automatically; everything
    // else (busy device, transient security errors, aborts)
    // is worth retrying with backoff.
    return (
      name !== "NotAllowedError" &&
      name !== "PermissionDeniedError" &&
      name !== "NotFoundError" &&
      name !== "DevicesNotFoundError" &&
      name !== "SecurityError"
    );
  }

  // =========================================================
  // CAMERA RECOVERY SCHEDULING
  //
  // Retries camera startup with exponential backoff after
  // recoverable failures (busy device, transient errors, or
  // a stream that unexpectedly ends), up to a max attempt
  // count so we don't loop forever.
  // =========================================================

  function scheduleCameraRecovery(immediate) {
    if (cameraRecoveryTimer) {
      clearTimeout(cameraRecoveryTimer);

      cameraRecoveryTimer = null;
    }

    if (
      cameraRecoveryAttempts >=
      MAX_CAMERA_RECOVERY_ATTEMPTS
    ) {
      instructions.textContent =
        "Unable to start the camera after several attempts. Please reload the page.";

      return;
    }

    cameraRecoveryAttempts += 1;

    const delay = immediate
      ? 0
      : CAMERA_RECOVERY_BASE_DELAY_MS *
        Math.pow(
          2,
          cameraRecoveryAttempts - 1
        );

    console.log(
      `Scheduling camera recovery attempt ${cameraRecoveryAttempts} in ${delay}ms`
    );

    cameraRecoveryTimer = setTimeout(() => {
      cameraRecoveryTimer = null;

      startCamera();
    }, delay);
  }

  // =========================================================
  // START CAMERA
  // =========================================================

  async function startCamera() {
    if (cameraStarting) {
      return;
    }

    cameraStarting = true;

    try {
      console.log(
        "Starting camera..."
      );

      instructions.textContent =
        "Checking camera availability...";

      captureBtn.disabled = true;

      // ---------------------------------------------------
      // Secure context check
      // ---------------------------------------------------

      if (!isSecureContextForCamera()) {
        instructions.textContent =
          "Camera access requires a secure connection (HTTPS) or localhost. Please load this page securely.";

        return;
      }

      // ---------------------------------------------------
      // Browser compatibility shim
      // ---------------------------------------------------

      ensureGetUserMediaShim();

      if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices
          .getUserMedia
      ) {
        throw Object.assign(
          new Error(
            "Camera API unavailable in this browser. Try the latest Chrome, Edge, Firefox, or Safari."
          ),
          { name: "NotSupportedError" }
        );
      }

      // ---------------------------------------------------
      // Device availability pre-check
      // ---------------------------------------------------

      const deviceLikelyAvailable =
        await hasVideoInputDevice();

      if (!deviceLikelyAvailable) {
        throw Object.assign(
          new Error(
            "No camera detected on this device."
          ),
          { name: "NotFoundError" }
        );
      }

      instructions.textContent =
        "Requesting camera permission...";

      stopCamera();

      // ---------------------------------------------------
      // Attempt to acquire the camera stream, first with an
      // ideal high-resolution request, then falling back to
      // relaxed constraints if the device can't satisfy it.
      // ---------------------------------------------------

      const constraintAttempts = [
        {
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
          audio: false,
        },
        {
          video: true,
          audio: false,
        },
      ];

      let lastConstraintError = null;

      for (
        const constraints
        of constraintAttempts
      ) {
        try {
          cameraStream =
            await navigator.mediaDevices.getUserMedia(
              constraints
            );

          lastConstraintError = null;

          break;
        } catch (attemptError) {
          lastConstraintError =
            attemptError;

          console.warn(
            "getUserMedia attempt failed, trying fallback constraints:",
            attemptError
          );

          if (
            !isRecoverableCameraError(
              attemptError
            ) &&
            attemptError.name !==
              "OverconstrainedError" &&
            attemptError.name !==
              "ConstraintNotSatisfiedError"
          ) {
            // No point trying looser constraints for a
            // permission or hardware-absence error.
            throw attemptError;
          }
        }
      }

      if (!cameraStream) {
        throw (
          lastConstraintError ||
          new Error(
            "Unable to acquire camera stream."
          )
        );
      }

      console.log(
        "Camera stream:",
        cameraStream
      );

      const videoTracks =
        cameraStream
          .getVideoTracks();

      if (
        videoTracks.length === 0
      ) {
        throw Object.assign(
          new Error(
            "No video camera available."
          ),
          { name: "NotFoundError" }
        );
      }

      const cameraTrack =
        videoTracks[0];

      console.log(
        "Camera:",
        cameraTrack.label
      );

      console.log(
        "Settings:",
        cameraTrack.getSettings()
      );

      // ---------------------------------------------------
      // Detect unexpected stream termination (e.g. device
      // unplugged, permission revoked externally, another
      // app taking exclusive control) and recover.
      // ---------------------------------------------------

      if (!trackEndedHandlerAttached) {
        trackEndedHandlerAttached = true;
      }

      cameraTrack.addEventListener(
        "ended",
        () => {
          console.warn(
            "Camera track ended unexpectedly."
          );

          if (
            !capturing &&
            !cameraStarting
          ) {
            instructions.textContent =
              "Camera disconnected. Attempting to reconnect...";

            stopValidationLoop();

            stopCamera();

            scheduleCameraRecovery(false);
          }
        }
      );

      video.srcObject =
        cameraStream;

      video.autoplay = true;

      video.muted = true;

      video.playsInline = true;

      await waitForVideoMetadata();

      await video.play();

      console.log(
        "Camera preview started."
      );

      console.log(
        "Resolution:",
        video.videoWidth,
        "x",
        video.videoHeight
      );

      instructions.textContent =
        "Stand straight and keep your full body visible.";

      // Successful start resets recovery bookkeeping.

      cameraRecoveryAttempts = 0;

      if (cameraRecoveryTimer) {
        clearTimeout(
          cameraRecoveryTimer
        );

        cameraRecoveryTimer = null;
      }

      drawReticle();

      window.addEventListener(
        "resize",
        drawReticle
      );

      watchCameraPermission();

      startValidationLoop();

    } catch (error) {
      console.error(
        "CAMERA ERROR:",
        error
      );

      captureBtn.disabled = true;

      instructions.textContent =
        describeCameraError(error);

      if (isRecoverableCameraError(error)) {
        scheduleCameraRecovery(false);
      }

    } finally {
      cameraStarting = false;
    }
  }

  // =========================================================
  // WAIT FOR VIDEO
  // =========================================================

  function waitForVideoMetadata() {
    return new Promise(
      (resolve, reject) => {
        if (
          video.readyState >= 1
        ) {
          resolve();

          return;
        }

        const metadataHandler =
          () => {
            cleanup();

            resolve();
          };

        const errorHandler =
          () => {
            cleanup();

            reject(
              new Error(
                "Unable to load camera."
              )
            );
          };

        function cleanup() {
          video.removeEventListener(
            "loadedmetadata",
            metadataHandler
          );

          video.removeEventListener(
            "error",
            errorHandler
          );
        }

        video.addEventListener(
          "loadedmetadata",
          metadataHandler
        );

        video.addEventListener(
          "error",
          errorHandler
        );
      }
    );
  }

  // =========================================================
  // STOP CAMERA
  // =========================================================

  function stopCamera() {
    if (cameraStream) {
      cameraStream
        .getTracks()
        .forEach(
          (track) =>
            track.stop()
        );

      cameraStream = null;
    }

    if (video.srcObject) {
      video.srcObject = null;
    }
  }

  // =========================================================
  // GRAB FRAME
  // =========================================================

  function grabFrame(maxWidth) {
    if (
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return null;
    }

    const scale = Math.min(
      1,
      maxWidth /
        video.videoWidth
    );

    const width = Math.round(
      video.videoWidth * scale
    );

    const height = Math.round(
      video.videoHeight * scale
    );

    captureCanvas.width =
      width;

    captureCanvas.height =
      height;

    const context =
      captureCanvas
        .getContext("2d");

    context.save();

    context.clearRect(
      0,
      0,
      width,
      height
    );

    context.translate(
      width,
      0
    );

    context.scale(
      -1,
      1
    );

    context.drawImage(
      video,
      0,
      0,
      width,
      height
    );

    context.restore();

    return captureCanvas
      .toDataURL(
        "image/jpeg",
        0.90
      );
  }

  // =========================================================
  // CHECKLIST
  // =========================================================

  function applyChecklist(checks) {
    checklist
      .querySelectorAll("li")
      .forEach((li) => {
        const key =
          li.dataset.check;

        const passed =
          Boolean(
            checks[key]
          );

        li.classList.toggle(
          "pass",
          passed
        );

        li.classList.toggle(
          "fail",
          !passed
        );
      });
  }

  // =========================================================
  // VALIDATE POSE
  // =========================================================

  async function validateOnce() {
    if (
      validating ||
      capturing ||
      autoShutterTriggered ||
      !video.videoWidth
    ) {
      return;
    }

    if (
      currentIndex >=
      viewOrder.length
    ) {
      return;
    }

    validating = true;

    try {
      const image =
        grabFrame(480);

      if (!image) {
        return;
      }

      const currentView =
        viewOrder[currentIndex];

      const response =
        await fetch(
          "/api/validate_pose",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              view:
                currentView,

              image:
                image,
            }),
          }
        );

      if (!response.ok) {
        throw new Error(
          `Validation failed: ${response.status}`
        );
      }

      const data =
        await response.json();

      console.log(
        "Validation:",
        currentView,
        data
      );

      lastValidationOk =
        Boolean(data.ok);

      applyChecklist(
        data.checks || {}
      );

      drawReticle();

      // =====================================================
      // VALID POSE
      // =====================================================

      if (data.ok) {
        stablePoseCount += 1;

        console.log(
          "Stable pose:",
          stablePoseCount,
          "/",
          REQUIRED_STABLE_CHECKS
        );

        const remaining =
          REQUIRED_STABLE_CHECKS -
          stablePoseCount;

        if (remaining > 0) {
          instructions.textContent =
            `Position correct — hold still (${remaining})`;
        }

        // Trigger automatic shutter

        if (
          stablePoseCount >=
          REQUIRED_STABLE_CHECKS
        ) {
          autoShutterTriggered =
            true;

          instructions.textContent =
            "Position confirmed — capturing...";

          await autoCapture();
        }
      }

      // =====================================================
      // INVALID POSE
      // =====================================================

      else {
        stablePoseCount = 0;

        autoShutterTriggered =
          false;

        instructions.textContent =
          (
            data.messages &&
            data.messages[0]
          ) ||
          "Adjust your position";
      }

    } catch (error) {
      console.error(
        "POSE VALIDATION ERROR:",
        error
      );

      stablePoseCount = 0;

      lastValidationOk = false;

      instructions.textContent =
        "Connection issue — retrying...";

    } finally {
      validating = false;
    }
  }

  // =========================================================
  // AUTO CAPTURE
  // =========================================================

  async function autoCapture() {
    if (capturing) {
      return;
    }

    capturing = true;

    const currentView =
      viewOrder[currentIndex];

    try {
      /*
       * Short delay gives the person time
       * to remain still before shutter.
       */

      await sleep(500);

      instructions.textContent =
        `Capturing ${currentView}...`;

      const image =
        grabFrame(1280);

      if (!image) {
        throw new Error(
          "Camera frame unavailable."
        );
      }

      const response =
        await fetch(
          "/api/capture_image",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              participant_id:
                participantId,

              view:
                currentView,

              image:
                image,
            }),
          }
        );

      if (!response.ok) {
        throw new Error(
          `Capture failed: ${response.status}`
        );
      }

      const data =
        await response.json();

      console.log(
        "Capture response:",
        data
      );

      if (!data.success) {
        throw new Error(
          data.message ||
          "Image save failed."
        );
      }

      // Image saved

      alreadyCaptured.add(
        currentView
      );

      stablePoseCount = 0;

      lastValidationOk = false;

      applyChecklist({});

      // =====================================================
      // ALL IMAGES COMPLETE
      // =====================================================

      if (data.done) {
        instructions.textContent =
          "Front, side and back images captured successfully.";

        stopValidationLoop();

        stopCamera();

        window.location.href =
          `/success/${participantId}`;

        return;
      }

      // =====================================================
      // NEXT VIEW
      // =====================================================

      currentIndex =
        viewOrder.findIndex(
          (view) =>
            !alreadyCaptured.has(view)
        );

      if (currentIndex === -1) {
        stopValidationLoop();

        stopCamera();

        window.location.href =
          `/success/${participantId}`;

        return;
      }

      updateSequenceUI();

      const nextView =
        viewOrder[currentIndex];

      instructions.textContent =
        `${currentView.toUpperCase()} saved. Get ready for ${nextView.toUpperCase()}.`;

      drawReticle();

      /*
       * Prevent immediate validation while
       * participant turns to next position.
       */

      await sleep(2000);

      autoShutterTriggered =
        false;

    } catch (error) {
      console.error(
        "AUTO CAPTURE ERROR:",
        error
      );

      instructions.textContent =
        `Capture failed: ${error.message}`;

      stablePoseCount = 0;

      lastValidationOk = false;

      autoShutterTriggered =
        false;

    } finally {
      capturing = false;
    }
  }

  // =========================================================
  // SLEEP
  // =========================================================

  function sleep(milliseconds) {
    return new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          milliseconds
        )
    );
  }

  // =========================================================
  // VALIDATION LOOP
  // =========================================================

  function startValidationLoop() {
    console.log(
      "Starting pose validation..."
    );

    updateSequenceUI();

    if (validationInterval) {
      clearInterval(
        validationInterval
      );
    }

    validateOnce();

    validationInterval =
      setInterval(
        validateOnce,
        900
      );
  }

  // =========================================================
  // STOP VALIDATION
  // =========================================================

  function stopValidationLoop() {
    if (validationInterval) {
      clearInterval(
        validationInterval
      );

      validationInterval = null;
    }
  }

  // =========================================================
  // MANUAL BUTTON DISABLED
  // =========================================================

  captureBtn.disabled = true;

  captureBtn.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
    }
  );

  // =========================================================
  // VISIBILITY / RECOVERY HOOKS
  //
  // If the tab regains visibility or the browser reports it
  // is back online after a drop, and the camera isn't
  // currently running, attempt to recover automatically
  // rather than leaving the participant stuck.
  // =========================================================

  document.addEventListener(
    "visibilitychange",
    () => {
      if (
        document.visibilityState ===
          "visible" &&
        !cameraStream &&
        !cameraStarting &&
        !cameraRecoveryTimer
      ) {
        console.log(
          "Tab visible again with no active camera — attempting recovery."
        );

        cameraRecoveryAttempts = 0;

        scheduleCameraRecovery(true);
      }
    }
  );

  window.addEventListener(
    "online",
    () => {
      if (
        !cameraStream &&
        !cameraStarting &&
        !cameraRecoveryTimer
      ) {
        console.log(
          "Network back online — attempting camera recovery."
        );

        cameraRecoveryAttempts = 0;

        scheduleCameraRecovery(true);
      }
    }
  );

  // =========================================================
  // CLEANUP
  // =========================================================

  window.addEventListener(
    "beforeunload",
    () => {
      stopValidationLoop();

      stopCamera();

      if (cameraRecoveryTimer) {
        clearTimeout(
          cameraRecoveryTimer
        );

        cameraRecoveryTimer = null;
      }

      if (
        permissionStatusRef &&
        permissionStatusRef.onchange
      ) {
        permissionStatusRef.onchange =
          null;
      }
    }
  );

  // =========================================================
  // START APP
  // =========================================================

  updateSequenceUI();

  startCamera();

})();