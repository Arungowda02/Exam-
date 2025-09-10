import React, { useState } from "react";

// Demo password for inspection
const DEMO_PASSWORD = "admin";

// Import the same questions used in Exam.jsx
// import questions from '../data/questions'

export default function Inspection() {
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [results, setResults] = useState([]);

  function login() {
    if (pw === DEMO_PASSWORD) {
      setAuthed(true);
      const r = JSON.parse(localStorage.getItem("exam_results") || "[]");
      setResults(r.reverse());
    } else {
      alert("Wrong password");
    }
  }

  function calculateScore(result) {
    if (result.status !== "submitted") return null;

    // let correct = 0
    // questions.forEach((q, idx) => {
    //   if (result.answers && result.answers[idx] === q.answer) {
    //     correct++
    //   }
    // })
    // return `${correct} / ${questions.length}`
    return `${result.score} / ${result.total}`;
  }

  if (!authed) {
    return (
      <div className="page center">
        <h1>Inspection Login</h1>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          className="input"
        />
        <button onClick={login} className="btn">
          Open
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="title">📊 Exam Inspection</h1>
      {results.length === 0 && <p>No exam results yet.</p>}
      {results.length > 0 && (
        <table className="results-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Score</th>
              <th>Time taken (s)</th>
              <th>Warnings (face/mic/tab)</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                <td>{r.email}</td>
                <td
                  style={{ color: r.status === "submitted" ? "green" : "red" }}
                >
                  {r.status}
                </td>
                <td>{r.reason}</td>
                <td>
                  {calculateScore(r) || (
                    <span style={{ color: "gray" }}>No result</span>
                  )}
                </td>
                <td>{r.timeTakenSeconds}</td>
                <td>
                  {r.warnings?.face || 0} / {r.warnings?.mic || 0} /{" "}
                  {r.warnings?.tab || 0}
                </td>
                <td>{new Date(r.startTs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
