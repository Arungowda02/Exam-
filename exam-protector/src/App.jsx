import React from 'react'
import { Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing'
import Exam from './pages/Exam'
import Inspection from './pages/Inspection'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/exam" element={<Exam />} />
      <Route path="/admin" element={<Inspection />} />
    </Routes>
  )
}
