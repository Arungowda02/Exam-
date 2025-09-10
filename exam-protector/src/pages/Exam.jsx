/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as faceDetection from "@tensorflow-models/face-detection";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
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
  const [warningMsg, setWarningMsg] = useState("");

  // refs
  const videoRef = useRef(null);
  const detectorRef = useRef(null);
  const objectDetectorRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafId = useRef(null);

  // flags
  const faceActiveRef = useRef(false);
  const objectActiveRef = useRef(false);
  const micActiveRef = useRef(false);
  const tabActiveRef = useRef(false);
  const refreshActiveRef = useRef(false);
  const popupOpenRef = useRef(false);
  const lastActionRef = useRef(null);

  // thresholds
  const FACE_TOLERANCE = 310; // pixels distance from center allowed
  const MIC_VOLUME_THRESHOLD = 0.005;
  const MIC_NOISE_FRAMES = 900;

  const [warnings, setWarnings] = useState({
    face: 0,
    mic: 0,
    tab: 0,
    refresh: 0,
    object: 0,
  });

  // -------------------------
  // Load user info
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
  // Timer
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
  // Setup media and detectors
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
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // face detector
        detectorRef.current = await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          { runtime: "tfjs", maxFaces: 3 }
        );

        // object detector
        objectDetectorRef.current = await cocoSsd.load();

        // mic setup
        audioCtxRef.current = new (window.AudioContext ||
          window.webkitAudioContext)();
        const source = audioCtxRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 512;
        source.connect(analyserRef.current);

        // start loops
        detectLoop();
        micLoop();

        // tab / refresh listeners
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("beforeunload", handleRefresh);
      } catch (err) {
        console.error("Setup error:", err);
        setWarningMsg("Error accessing camera/mic: " + (err?.message || err));
        popupOpenRef.current = true;
      }
    }

    setup();

    return () => {
      mounted = false;
      stopStreams();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleRefresh);
      if (rafId.current) cancelAnimationFrame(rafId.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // -------------------------
  // Helpers
  // -------------------------
  function stopStreams() {
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
    }
    if (audioCtxRef.current) audioCtxRef.current.close();
  }

  function saveResult(status, reason, score = null) {
    const startTs = Number(sessionStorage.getItem("exam_start_ts") || Date.now());
    const timeTakenSeconds = Math.floor((Date.now() - startTs) / 1000);
    const results = JSON.parse(localStorage.getItem("exam_results") || "[]");
    results.push({
      name: user?.name,
      email: user?.email,
      status,
      reason,
      warnings,
      score,
      total: questions.length,
      answers,
      startTs,
      timeTakenSeconds,
    });
    localStorage.setItem("exam_results", JSON.stringify(results));
  }

  // -------------------------
  // Violation handler
  // -------------------------
  function handleViolation(type, reason) {
    if (popupOpenRef.current) return;

    popupOpenRef.current = true;
    setWarnings((prev) => {
      const next = { ...prev, [type]: prev[type] + 1 };
      const count = next[type];

      if (count < 3) {
        setWarningMsg(`Warning ${count}: ${reason}`);
      } else {
        setWarningMsg(`Exam terminated due to ${reason}`);
        setTerminated(true);
        stopStreams();
        saveResult("terminated", reason);
        lastActionRef.current = "terminated";
      }

      return next;
    });
  }

  // -------------------------
  // Face + Object detection loop
  // -------------------------
 // -------------------------
// Face + Object detection loop
// -------------------------
async function detectLoop() {
  if (popupOpenRef.current || terminated) return;
  if (!videoRef.current || !detectorRef.current || !objectDetectorRef.current) {
    rafId.current = requestAnimationFrame(detectLoop);
    return;
  }

  try {
    const faces = await detectorRef.current.estimateFaces(videoRef.current);
    const objects = await objectDetectorRef.current.detect(videoRef.current);

    let issue = false;

    // multiple faces
    if (faces.length > 1) {
      issue = true;
      if (!faceActiveRef.current) {
        faceActiveRef.current = true;
        handleViolation("face", "Multiple faces detected in frame");
        return;
      }
    }

    // no face at all (user moved completely out of frame)
    if (faces.length === 0) {
      issue = true;
      if (!faceActiveRef.current) {
        faceActiveRef.current = true;
        handleViolation("face", "User moved out of camera frame");
        return;
      }
    } else {
      // one face present → check distance from center
      const box = faces[0].box;
      const center = {
        x: box.xMin + box.width / 2,
        y: box.yMin + box.height / 2,
      };
      const frameCenter = {
        x: (videoRef.current.videoWidth || 640) / 2,
        y: (videoRef.current.videoHeight || 480) / 2,
      };
      const dist = Math.hypot(center.x - frameCenter.x, center.y - frameCenter.y);
      if (dist > FACE_TOLERANCE) {
        issue = true;
        if (!faceActiveRef.current) {
          faceActiveRef.current = true;
          handleViolation("face", "Face moved away from camera center");
          return;
        }
      }
    }

    // reset flag when ok
    if (!issue) faceActiveRef.current = false;

    // object detection: phone or another person
    const phoneDetected = objects.some((o) => o.class === "cell phone" && o.score > 0.6);
    const personCount = objects.filter((o) => o.class === "person" && o.score > 0.6).length;

    if (phoneDetected || personCount > 1) {
      if (!objectActiveRef.current) {
        objectActiveRef.current = true;
        handleViolation(
          "object",
          phoneDetected ? "Mobile phone detected" : "Multiple persons detected"
        );
        return;
      }
    } else {
      objectActiveRef.current = false;
    }
  } catch (err) {
    console.warn("Detection error:", err);
  }

  rafId.current = requestAnimationFrame(detectLoop);
}


  // -------------------------
  // Mic detection
  // -------------------------
  let noiseCounter = useRef(0);
  function micLoop() {
    if (popupOpenRef.current || terminated) return;
    if (!analyserRef.current) {
      requestAnimationFrame(micLoop);
      return;
    }

    const bufferLength = analyserRef.current.fftSize;
    const data = new Uint8Array(bufferLength);
    analyserRef.current.getByteTimeDomainData(data);

    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);

    if (rms > MIC_VOLUME_THRESHOLD) {
      noiseCounter.current++;
      if (noiseCounter.current >= MIC_NOISE_FRAMES) {
        if (!micActiveRef.current) {
          micActiveRef.current = true;
          handleViolation("mic", "Noise detected on microphone");
          noiseCounter.current = 0;
          return;
        }
      }
    } else {
      noiseCounter.current = 0;
      micActiveRef.current = false;
    }

    requestAnimationFrame(micLoop);
  }

  // -------------------------
  // Tab visibility
  // -------------------------
  function handleVisibility() {
    if (document.visibilityState === "hidden") {
      if (!tabActiveRef.current) {
        tabActiveRef.current = true;
        handleViolation("tab", "Tab hidden or minimized");
      }
    } else {
      tabActiveRef.current = false;
    }
  }

  // -------------------------
  // Refresh detection
  // -------------------------
  function handleRefresh(e) {
    if (!refreshActiveRef.current) {
      refreshActiveRef.current = true;
      handleViolation("refresh", "Page refresh detected");
      e.preventDefault();
      e.returnValue = "";
    }
  }

  // -------------------------
  // Submit
  // -------------------------
  function handleSubmit(reason = "submitted") {
    if (terminated) return;
    stopStreams();

    let score = 0;
    questions.forEach((q, i) => {
      if (answers[i] === q.correct) score++;
    });

    saveResult("submitted", reason, score);
    setWarningMsg(`Exam completed successfully.\nScore: ${score}/${questions.length}`);
    popupOpenRef.current = true;
    lastActionRef.current = "submitted";
    setTerminated(true);
  }

  // -------------------------
  // Popup close
  // -------------------------
  function handlePopupClose() {
    setWarningMsg("");
    popupOpenRef.current = false;
    faceActiveRef.current = false;
    micActiveRef.current = false;
    objectActiveRef.current = false;
    tabActiveRef.current = false;
    refreshActiveRef.current = false;

    if (lastActionRef.current === "terminated" || lastActionRef.current === "submitted") {
      navigate("/");
      return;
    }

    if (!terminated) {
      detectLoop();
      micLoop();
    }
  }

  // -------------------------
  // Helpers
  // -------------------------
  function formatTime(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, "0")}`;
  }

  const q = questions[currentQ];

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
              onClick={() => setCurrentQ((c) => Math.min(questions.length - 1, c + 1))}
              disabled={currentQ === questions.length - 1}
            >
              Next
            </button>
            <button onClick={() => handleSubmit("manual_submit")}>Submit Exam</button>
          </div>
        </div>

        <div className="camera-area">
          <video ref={videoRef} autoPlay playsInline muted className="camera-preview"></video>
          <div className="warnings">
            Face warnings: {warnings.face} <br />
            Mic warnings: {warnings.mic} <br />
            Tab warnings: {warnings.tab} <br />
            Refresh warnings: {warnings.refresh} <br />
            Object warnings: {warnings.object}
          </div>
        </div>
      </div>

      <WarningPopup message={warningMsg} onClose={handlePopupClose} />
    </div>
  );
}
