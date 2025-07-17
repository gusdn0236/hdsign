// src/App.jsx
import './App.css'
import React from 'react'
import {Routes, Route} from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
import Gallery from './pages/Gallery.jsx'
import About from "./pages/About.jsx";
import Support from "./pages/Support.jsx";

function App() {
    return (
        <div className="app-wrapper">
            <Header/>
            <main className="content">
                <Routes>
                    <Route path="/" element={<Home/>}/>
                    <Route path="/About" element={<About/>}/>
                    <Route path="/gallery" element={<Gallery/>}/>
                    <Route path="/Support" element={<Support/>}/>
                </Routes>
            </main>
            <Footer/>
        </div>
    )
}

export default App