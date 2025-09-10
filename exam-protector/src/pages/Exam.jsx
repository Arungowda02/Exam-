/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as faceDetection from "@tensorflow-models/face-detection";
import "@tensorflow/tfjs-backend-webgl";
import questions from "../data/questions";
import WarningPopup from "../components/WarningPopup";

export default function Exam() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(600); // 10 minutes
  const [terminated, setTerminated] = useState(false);

  // UI popup message
  const [warningMsg, setWarningMsg] = useState("");

  // refs for media and loops
  const videoRef = useRef(null);
  const detectorRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafId = useRef(null);

  // persistent counters / flags (use refs so they survive renders)
  const noiseCounterRef = useRef(0);
  const faceActiveRef = useRef(false); // indicates a face-issue is currently active (to avoid repeated warnings)
  const micActiveRef = useRef(false); // mic issue active
  const tabActiveRef = useRef(false); // tab issue active
  const refreshActiveRef = useRef(false); // refresh issue active
  const popupOpenRef = useRef(false); // is our custom popup currently open?
  const lastActionRef = useRef(null); // 'submitted'|'terminated' or null

  // thresholds (tune these)
  const FACE_TOLERANCE = 440; // pixels distance from center allowed
  const MIC_VOLUME_THRESHOLD = 0.005; // RMS threshold (0.001-0.01 typical)
  const MIC_NOISE_FRAMES = 90; // consecutive frames above threshold before counting as an incident

  // visible warning counters (for UI / saved results)
  const [warnings, setWarnings] = useState({
    face: 0,
    mic: 0,
    tab: 0,
    refresh: 0,
  });

  // -------------------------
  // load user/session info
  // -------------------------
  useEffect(() => {
    const u = JSON.parse(sessionStorage.getItem("exam_user") || "null");
    if (!u) {
      navigate("/");
      return;
    }
    setUser(u);
  }, [navigate]);

  // -------------------------
  // timer
  // -------------------------
  useEffect(() => {
    if (terminated) return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          handleSubmit("timeout");
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [terminated]);

  // -------------------------
  // setup media and detectors
  // -------------------------
  useEffect(() => {
    let mounted = true;

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true,
        });

        if (!mounted) {
          // stop if unmounted quickly
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // attach to preview
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch (_) {
            /* empty */
          }
        }

        // create face detector
        detectorRef.current = await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          { runtime: "tfjs", maxFaces: 1 }
        );

        // set up audio analyzer
        audioCtxRef.current = new (window.AudioContext ||
          window.webkitAudioContext)();
        sourceRef.current = audioCtxRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 512;
        sourceRef.current.connect(analyserRef.current);

        // start loops
        detectLoop();
        micLoop();

        // tab visibility
        document.addEventListener("visibilitychange", handleVisibility);

        // refresh (beforeunload) - note browsers limit custom text in confirm
        window.addEventListener("beforeunload", handleRefresh);
      } catch (err) {
        console.error("Setup error:", err);
        setWarningMsg("Error accessing camera/mic: " + (err?.message || err));
        popupOpenRef.current = true;
        lastActionRef.current = null;
      }
    }

    setup();

    return () => {
      mounted = false;
      stopStreams();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleRefresh);
      if (rafId.current) cancelAnimationFrame(rafId.current);
      try {
        if (audioCtxRef.current) audioCtxRef.current.close();
      } catch (_) {
        /* empty */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------
  // helpers: stop streams & save result
  // -------------------------
  function stopStreams() {
    try {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
    } catch (e) {
      /* empty */
    }
    try {
      if (audioCtxRef.current) audioCtxRef.current.close();
    } catch (e) {
      /* empty */
    }
  }

  function saveResult(status, reason, score = null) {
    const startTs = Number(
      sessionStorage.getItem("exam_start_ts") || Date.now()
    );
    const timeTakenSeconds = Math.floor((Date.now() - startTs) / 1000);
    const results = JSON.parse(localStorage.getItem("exam_results") || "[]");
    results.push({
      name: user?.name,
      email: user?.email,
      status,
      reason,
      warnings,
      score, // ✅ store score
      total: questions.length, // ✅ store total
      answers, // ✅ store user answers
      startTs,
      timeTakenSeconds,
    });
    localStorage.setItem("exam_results", JSON.stringify(results));
  }

  // -------------------------
  // central violation handler
  // -------------------------
  function handleViolation(type, reason) {
    // don't trigger another popup if one is open
    if (popupOpenRef.current) return;

    // mark popup open
    popupOpenRef.current = true;

    // increment visible counters (state)
    setWarnings((prev) => {
      const next = { ...prev, [type]: prev[type] + 1 };
      const count = next[type];

      if (count < 3) {
        setWarningMsg(`Warning ${count}: ${reason}`);
      } else {
        // 3rd warning -> terminated
        setWarningMsg(`Exam terminated due to ${reason}`);
        // perform termination (stop streams + save result). Do NOT navigate yet — wait for user to close popup.
        setTerminated(true);
        stopStreams();
        saveResult("terminated", reason);
        lastActionRef.current = "terminated";
      }

      return next;
    });
  }

  // -------------------------
  // face detection loop (pauses itself on a detected issue)
  // -------------------------
  async function detectLoop() {
    // if popup open or terminated -> do not run detection
    if (popupOpenRef.current || terminated) return;
    if (!videoRef.current || !detectorRef.current) {
      rafId.current = requestAnimationFrame(detectLoop);
      return;
    }

    try {
      const faces = await detectorRef.current.estimateFaces(videoRef.current);
      let issue = false;

      if (faces && faces.length > 0) {
        const box = faces[0].box;
        const center = {
          x: box.xMin + box.width / 2,
          y: box.yMin + box.height / 2,
        };
        const frameCenter = {
          x: (videoRef.current.videoWidth || 640) / 2,
          y: (videoRef.current.videoHeight || 480) / 2,
        };
        const dist = Math.hypot(
          center.x - frameCenter.x,
          center.y - frameCenter.y
        );
        if (dist > FACE_TOLERANCE) issue = true;
      } else {
        // no face found = issue
        issue = true;
      }

      if (issue) {
        // only fire when there is no active face-issue and no popup
        if (!faceActiveRef.current && !popupOpenRef.current) {
          faceActiveRef.current = true;
          handleViolation(
            "face",
            "Face not in proper position / moved away from center"
          );
          // pause detection: do not schedule another frame here.
          return;
        }
      } else {
        // face ok — reset faceActive so next incident will produce a new warning
        faceActiveRef.current = false;
      }
    } catch (err) {
      console.warn("Face detection error:", err);
    }

    rafId.current = requestAnimationFrame(detectLoop);
  }

  // -------------------------
  // mic detection loop (pauses itself on an incident)
  // -------------------------
  function micLoop() {
    // if popup open or terminated -> do not run detection
    if (popupOpenRef.current || terminated) return;
    if (!analyserRef.current) {
      requestAnimationFrame(micLoop);
      return;
    }

    const bufferLength = analyserRef.current.fftSize;
    const data = new Uint8Array(bufferLength);
    analyserRef.current.getByteTimeDomainData(data);

    // compute RMS of time-domain signal
    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);

    // noise detection logic: require several consecutive frames above threshold
    if (rms > MIC_VOLUME_THRESHOLD) {
      noiseCounterRef.current += 1;
      if (noiseCounterRef.current >= MIC_NOISE_FRAMES) {
        if (!micActiveRef.current && !popupOpenRef.current) {
          micActiveRef.current = true;
          handleViolation("mic", "Noise detected on microphone");
          // pause mic detection until popup closed
          noiseCounterRef.current = 0;
          return;
        }
      }
    } else {
      // reset counter and active flag once silent
      noiseCounterRef.current = 0;
      micActiveRef.current = false;
    }

    requestAnimationFrame(micLoop);
  }

  // -------------------------
  // tab visibility handler
  // -------------------------
  function handleVisibility() {
    if (document.visibilityState === "hidden") {
      if (!tabActiveRef.current && !popupOpenRef.current) {
        tabActiveRef.current = true;
        handleViolation("tab", "Tab hidden or minimized");
        // when user returns visibilitychange event will fire to visible, we reset below:
      }
    } else {
      // user returned — allow future tab incidents
      tabActiveRef.current = false;
    }
  }

  // -------------------------
  // refresh detection (beforeunload)
  // -------------------------
  function handleRefresh(e) {
    if (!refreshActiveRef.current && !popupOpenRef.current) {
      refreshActiveRef.current = true;
      handleViolation("refresh", "Page refresh detected");
      // Ask browser to confirm unload — modern browsers don't show custom text, but returning value triggers confirm
      e.preventDefault();
      e.returnValue = "";
    }
    // if popup already open, allow default browser behavior
  }

  // -------------------------
  // submit and termination flow
  // -------------------------
  function handleSubmit(reason = "submitted") {
    if (terminated) return;
    // stop media immediately
    stopStreams();

    // compute score
    let score = 0;
    questions.forEach((q, i) => {
      if (answers[i] === q.correct) score++;
    });

    // save result
    saveResult("submitted", reason, score);

    // show popup message and mark as ended
    setWarningMsg(
      `Exam completed successfully. Thank you.\nScore: ${score}/${questions.length}`
    );
    popupOpenRef.current = true;
    lastActionRef.current = "submitted";
    setTerminated(true);
  }

  // -------------------------
  // popup close handler — resumes loops or navigates depending on last action
  // -------------------------
  function handlePopupClose() {
    setWarningMsg("");
    popupOpenRef.current = false;

    // reset active flags so new incidents can be detected again
    faceActiveRef.current = false;
    micActiveRef.current = false;
    tabActiveRef.current = false;
    refreshActiveRef.current = false;
    noiseCounterRef.current = 0;

    // if exam was terminated or submitted, navigate back to landing (or inspection) after user closes
    if (
      lastActionRef.current === "terminated" ||
      lastActionRef.current === "submitted"
    ) {
      lastActionRef.current = null;
      navigate("/");
      return;
    }

    // otherwise resume detection loops
    if (!terminated) {
      detectLoop();
      micLoop();
    }
  }

  // -------------------------
  // helpers
  // -------------------------
  function formatTime(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, "0")}`;
  }

  const q = questions[currentQ];

  // -------------------------
  // render
  // -------------------------
  return (
    <div className="page exam-container">
      <div className="exam-top">
        <h2>Exam in Progress — {user?.name}</h2>
        <div className="timer">Time Left: {formatTime(timeLeft)}</div>
      </div>

      <div className="exam-body">
        <div className="question-area">
          <h3 className="question-text">
            Q{currentQ + 1}. {q.question}
          </h3>
          <div className="options">
            {q.options.map((opt, idx) => (
              <label key={idx} className="option-label">
                <input
                  type="radio"
                  checked={answers[currentQ] === idx}
                  onChange={() => setAnswers({ ...answers, [currentQ]: idx })}
                />{" "}
                {opt}
              </label>
            ))}
          </div>

          <div className="nav-buttons">
            <button
              onClick={() => setCurrentQ((c) => Math.max(0, c - 1))}
              disabled={currentQ === 0}
            >
              Prev
            </button>
            <button
              onClick={() =>
                setCurrentQ((c) => Math.min(questions.length - 1, c + 1))
              }
              disabled={currentQ === questions.length - 1}
            >
              Next
            </button>
            <button onClick={() => handleSubmit("manual_submit")}>
              Submit Exam
            </button>
          </div>
        </div>

        <div className="camera-area">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="camera-preview"
          ></video>
          <div className="warnings">
            Face warnings: {warnings.face} <br />
            Mic warnings: {warnings.mic} <br />
            Tab warnings: {warnings.tab} <br />
            Refresh warnings: {warnings.refresh}
          </div>
        </div>
      </div>

      <WarningPopup message={warningMsg} onClose={handlePopupClose} />
    </div>
  );
}
