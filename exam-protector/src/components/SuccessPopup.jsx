import React from 'react'

export default function SuccessPopup({ message, onClose }) {
  if (!message) return null

  return (
    <div className="popup-overlay">
      <div className="popup-box">
        <h3>Congratulations 🎊</h3>
        <p>{message}</p>
        <button onClick={onClose}>OK</button>
      </div>
    </div>
  )
}
