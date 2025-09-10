import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Landing() {
  const [permissionStatus, setPermissionStatus] = useState("pending"); // 'pending' | 'granted' | 'denied'
  const [error, setError] = useState(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [nameError, setNameError] = useState("");
  const navigate = useNavigate();

  // Debounce timer
  const [debounceTimer, setDebounceTimer] = useState(null);

  useEffect(() => {
    // Always ask for permission again on page load/refresh
    let mounted = true;
    async function ask() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        if (!mounted) return;
        setPermissionStatus("granted");
      } catch (err) {
        console.error("permission error", err);
        setError(err.message || String(err));
        setPermissionStatus("denied");
      }
    }
    ask();
    return () => {
      mounted = false;
    };
  }, []);

  // Email validation
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Name validation (letters + spaces only)
  function isValidName(name) {
    return /^[A-Za-z\s]+$/.test(name.trim());
  }

  // Handle name validation live
  useEffect(() => {
    if (name && !isValidName(name)) {
      setNameError("Name must contain letters and spaces only");
    } else {
      setNameError("");
    }
  }, [name]);

  // Debounced email validation
  useEffect(() => {
    if (debounceTimer) clearTimeout(debounceTimer);

    const timer = setTimeout(() => {
      if (email && !isValidEmail(email)) {
        setEmailError("Invalid email format");
      } else {
        setEmailError("");
      }
    }, 500); // 500ms debounce

    setDebounceTimer(timer);

    return () => clearTimeout(timer);
  }, [email]);

  const canStartExam =
    permissionStatus === "granted" &&
    name.trim() &&
    !nameError &&
    email.trim() &&
    !emailError;

  function startExam() {
    if (!canStartExam) return;
    sessionStorage.setItem("exam_user", JSON.stringify({ name, email }));
    sessionStorage.setItem("exam_start_ts", String(Date.now()));
    navigate("/exam");
  }

  return (
    <div className="page center">
      <div className="landing-card">
        <h1 className="title">Test Exam for Project</h1>
        <p className="subtitle">Secure Online Exam System</p>

        {permissionStatus === "pending" && (
          <p className="status">Requesting camera & microphone permission...</p>
        )}
        {permissionStatus === "granted" && (
          <p className="status success">
            Permissions granted — enter your details to start.
          </p>
        )}
        {permissionStatus === "denied" && (
          <div className="status error">
            <p>Permissions denied. Allow camera & mic to continue.</p>
            <p className="error-detail">{error}</p>
            <button
              className="retry-btn"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

        <div className="form">
          <label>
            Name
            <input
              type="text"
              placeholder="Enter your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={permissionStatus !== "granted"}
            />
            {nameError && <p className="error-text">{nameError}</p>}
          </label>

          <label>
            Email
            <input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={permissionStatus !== "granted"}
            />
            {emailError && <p className="error-text">{emailError}</p>}
          </label>

          <button
            className={`start-btn ${canStartExam ? "enabled" : "disabled"}`}
            onClick={startExam}
            disabled={!canStartExam}
          >
            Start Exam
          </button>
        </div>
      </div>
    </div>
  );
}
