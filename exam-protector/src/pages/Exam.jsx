/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-empty */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as faceDetection from "@tensorflow-models/face-detection";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-backend-wasm";
import "@tensorflow/tfjs-backend-cpu";

import questions from "../data/questions";
import WarningPopup from "../components/WarningPopup";
import SuccessPopup from "../components/SuccessPopup";

export default function Exam() {
  const navigate = useNavigate();

  // states
  const [user, setUser] = useState(null);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(600);
  const [terminated, setTerminated] = useState(false);
  const [popupType, setPopupType] = useState("warning"); // "warning" | "success"
  const [popupMsg, setPopupMsg] = useState("");
  const [warnings, setWarnings] = useState({
    face: 0,
    mic: 0,
    tab: 0,
    refresh: 0,
    object: 0,
  });

  // refs
  const videoRef = useRef(null);
  const detectorRef = useRef(null);
  const objectDetectorRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);

  // flags
  const popupOpenRef = useRef(false);
  const lastActionRef = useRef(null);

  // tuning
  const FACE_TOLERANCE = 0.1;
  const SIZE_TOLERANCE = 0.1;
  const FACE_OUT_FRAMES = 10;
  const SMOOTHING_FACTOR = 0.2;
  const MIC_VOLUME_THRESHOLD = 0.015;
  const MIC_NOISE_FRAMES = 30;
  const CALIBRATION_TIME = 3000;

  // calibration refs
  const smoothedCenterRef = useRef({ x: 0, y: 0 });
  const smoothedInitializedRef = useRef(false);
  const referenceCenterRef = useRef(null);
  const calibrationDoneRef = useRef(false);
  const centerBufferRef = useRef([]);
  const referenceBoxRef = useRef(null);
  const faceOutCounter = useRef(0);
  const calibrationTimerRef = useRef(null);

  // setup user
  useEffect(() => {
    const u = JSON.parse(sessionStorage.getItem("exam_user") || "null");
    if (!u) {
      navigate("/");
      return;
    }
    setUser(u);
  }, [navigate]);

  // prevent refresh
  useEffect(() => {
    const blockRefreshKeys = (e) => {
      if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
        e.preventDefault();
        handleViolation("refresh", "Page refresh attempt detected");
      }
    };
    const blockBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
      handleViolation("refresh", "Page refresh attempt detected");
      return "";
    };
    window.addEventListener("keydown", blockRefreshKeys);
    window.addEventListener("beforeunload", blockBeforeUnload);

    return () => {
      window.removeEventListener("keydown", blockRefreshKeys);
      window.removeEventListener("beforeunload", blockBeforeUnload);
    };
  }, []);

  // timer
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

  // setup camera + detectors
  useEffect(() => {
    let mounted = true;

    async function setup() {
      try {
        await tf.setBackend("webgl").catch(() => tf.setBackend("wasm"));
        await tf.ready();
        console.log("✅ TFJS backend:", tf.getBackend());

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

        detectorRef.current = await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          { runtime: "tfjs", maxFaces: 3 }
        );

        objectDetectorRef.current = await cocoSsd.load();

        audioCtxRef.current = new (window.AudioContext ||
          window.webkitAudioContext)();
        const source = audioCtxRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 512;
        source.connect(analyserRef.current);

        detectLoop();
        micLoop();

        document.addEventListener("visibilitychange", handleVisibility);
      } catch (err) {
        console.error("Setup error:", err);
        setPopupMsg("Error accessing camera/mic: " + (err?.message || err));
        setPopupType("warning");
        popupOpenRef.current = true;
      }
    }

    setup();

    return () => {
      mounted = false;
      stopStreams();
      document.removeEventListener("visibilitychange", handleVisibility);
      if (audioCtxRef.current) audioCtxRef.current.close();
      if (calibrationTimerRef.current)
        clearTimeout(calibrationTimerRef.current);
    };
  }, []);

  function stopStreams() {
    try {
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
    } catch (_) {}
    try {
      if (audioCtxRef.current) audioCtxRef.current.close();
    } catch (_) {}
  }

  function handleViolation(type, reason) {
    if (popupOpenRef.current || terminated) return;

    setWarnings((prev) => {
      const newWarnings = { ...prev, [type]: prev[type] + 1 };

      if (newWarnings[type] > 2) {
        // Terminate exam
        setTerminated(true);
        popupOpenRef.current = true;
        setPopupType("warning");
        setPopupMsg(
          `❌ Exam terminated! Too many ${type} violations.\nReason: ${reason}`
        );
        lastActionRef.current = "terminated";
        console.log(`❌ Exam terminated due to ${type} violations`);
        stopStreams();
      } else {
        // Show normal warning popup
        popupOpenRef.current = true;
        setPopupType("warning");
        setPopupMsg(`⚠️ Warning (${newWarnings[type]}): ${reason}`);
        console.log(`⚠️ Warning #${newWarnings[type]} for ${type} - ${reason}`);
      }

      return newWarnings;
    });
  }

  let lastObjectDetect = 0;
  async function detectLoop() {
    if (popupOpenRef.current || terminated) return;
    if (!videoRef.current || !detectorRef.current) {
      setTimeout(detectLoop, 500);
      return;
    }

    try {
      const faces = await detectorRef.current.estimateFaces(videoRef.current);
      let objects = [];
      const now = Date.now();
      if (objectDetectorRef.current && now - lastObjectDetect > 3000) {
        objects = await objectDetectorRef.current.detect(videoRef.current);
        lastObjectDetect = now;
      }

      if (faces.length !== 1) {
        if (faces.length > 1)
          handleViolation("face", "Multiple faces detected");
        if (faces.length === 0) {
          faceOutCounter.current++;
          if (faceOutCounter.current >= FACE_OUT_FRAMES) {
            handleViolation("face", "User moved out of frame too long");
            faceOutCounter.current = 0;
          }
        }
      } else {
        const face = faces[0];
        const box = face.box;
        const rawCenter = {
          x: box.xMin + box.width / 2,
          y: box.yMin + box.height / 2,
        };

        if (!smoothedInitializedRef.current) {
          smoothedCenterRef.current = { ...rawCenter };
          smoothedInitializedRef.current = true;
          referenceBoxRef.current = { width: box.width, height: box.height };
          console.log("📍 First face detected", smoothedCenterRef.current);
        } else {
          smoothedCenterRef.current.x =
            SMOOTHING_FACTOR * rawCenter.x +
            (1 - SMOOTHING_FACTOR) * smoothedCenterRef.current.x;
          smoothedCenterRef.current.y =
            SMOOTHING_FACTOR * rawCenter.y +
            (1 - SMOOTHING_FACTOR) * smoothedCenterRef.current.y;
        }

        if (!calibrationDoneRef.current) {
          centerBufferRef.current.push({ ...smoothedCenterRef.current });
          if (!calibrationTimerRef.current) {
            calibrationTimerRef.current = setTimeout(() => {
              if (centerBufferRef.current.length > 0) {
                const sum = centerBufferRef.current.reduce(
                  (acc, c) => ({ x: acc.x + c.x, y: acc.y + c.y }),
                  { x: 0, y: 0 }
                );
                referenceCenterRef.current = {
                  x: sum.x / centerBufferRef.current.length,
                  y: sum.y / centerBufferRef.current.length,
                };
                calibrationDoneRef.current = true;
                console.log("✅ Calibration done", referenceCenterRef.current);
              }
              centerBufferRef.current = [];
              calibrationTimerRef.current = null;
            }, CALIBRATION_TIME);
          }
        } else {
          const frameW = videoRef.current.videoWidth || 640;
          const frameH = videoRef.current.videoHeight || 480;
          const dx = smoothedCenterRef.current.x - referenceCenterRef.current.x;
          const dy = smoothedCenterRef.current.y - referenceCenterRef.current.y;
          const normDist = Math.hypot(dx / frameW, dy / frameH);

          if (normDist > FACE_TOLERANCE) {
            handleViolation("face", "Face/body moved significantly");
          }

          if (referenceBoxRef.current) {
            const wChange =
              Math.abs(box.width - referenceBoxRef.current.width) /
              referenceBoxRef.current.width;
            const hChange =
              Math.abs(box.height - referenceBoxRef.current.height) /
              referenceBoxRef.current.height;

            if (wChange > SIZE_TOLERANCE || hChange > SIZE_TOLERANCE) {
              handleViolation(
                "face",
                "Face size changed - moved closer/farther"
              );
            }
          }
        }
      }

      if (objects.length > 0) {
        const ignoredClasses = ["person"]; // You can include "face" if supported
        const threshold = 0.6;

        const unwantedObjects = objects.filter(
          (o) => !ignoredClasses.includes(o.class) && o.score > threshold
        );

        const personCount = objects.filter(
          (o) => o.class === "person" && o.score > threshold
        ).length;

        if (unwantedObjects.length > 0) {
          const objectNames = unwantedObjects.map((o) => o.class).join(", ");
          handleViolation(
            "object",
            `Unexpected object(s) detected: ${objectNames}`
          );
        }

        if (personCount > 1) {
          handleViolation("object", "Multiple persons detected");
        }
      }
    } catch (err) {
      console.warn("Detection error:", err);
    }

    setTimeout(detectLoop, 500);
  }

  const noiseCounter = useRef(0);
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
        handleViolation("mic", "Noise detected");
        noiseCounter.current = 0;
        return;
      }
    } else {
      noiseCounter.current = 0;
    }

    requestAnimationFrame(micLoop);
  }

  function handleVisibility() {
    if (document.visibilityState === "hidden") {
      handleViolation("tab", "Tab hidden/minimized");
    }
  }

  function handleSubmit(reason = "submitted") {
    if (terminated) return;
    stopStreams();

    let score = 0;
    questions.forEach((q, i) => {
      if (answers[i] === q.correct) score++;
    });

    setPopupType("success");
    setPopupMsg(
      `🎉 Congratulations ${
        user?.name || ""
      }! Your exam was submitted successfully🌟\n\n\n\n📊 Your Score: ${score}/${
        questions.length
      }`
    );
    popupOpenRef.current = true;
    lastActionRef.current = "submitted";
    setTerminated(true);
  }

  function handlePopupClose() {
    setPopupMsg("");
    popupOpenRef.current = false;

    if (
      lastActionRef.current === "terminated" ||
      lastActionRef.current === "submitted"
    ) {
      navigate("/");
      return;
    }

    if (!terminated) {
      detectLoop();
      micLoop();
    }
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, "0")}`;
  }

  const q = questions[currentQ];

  return (
    <div className="page exam-container">
      <div className="exam-top">
        <h2>Exam is started {user?.name},</h2>
        <br />

        <div className="timer">Time Left: {formatTime(timeLeft)}</div>
      </div>
      <div>
        <h4>answer the following MCQ questions</h4>
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
            width={320}
            height={240}
          ></video>
          <div className="warnings">
            Face warnings: {warnings.face} <br />
            Mic warnings: {warnings.mic} <br />
            Tab warnings: {warnings.tab} <br />
            Refresh warnings: {warnings.refresh} <br />
            Object warnings: {warnings.object}
          </div>
        </div>
      </div>
      {/* ✅ Conditional rendering for popups */}
      {popupType === "success" ? (
        <SuccessPopup
          message={popupMsg}
          onClose={handlePopupClose}
          type={popupType}
        />
      ) : (
        <WarningPopup
          message={popupMsg}
          onClose={handlePopupClose}
          type={popupType}
        />
      )}
    </div>
  );
}
