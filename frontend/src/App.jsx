// src/App.jsx
import './App.css'
import React from 'react'
import {Routes, Route} from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
import Gallery from './pages/Gallery.jsx'
import Support from './pages/Support.jsx'


// About 관련
import AboutLayout from './pages/about/AboutLayout.jsx'
import Greeting from './pages/about/Greeting.jsx'
import Certification from './pages/about/Certification.jsx'
import Departments from './pages/about/Departments.jsx'
import Equipment from './pages/about/Equipment.jsx'
import Directions from './pages/about/Directions.jsx'

// Gallery 관련
import GalleryLayout from "./pages/gallery/GalleryLayout.jsx";
import Galva from "./pages/gallery/Galva.jsx";
import Stainless from './pages/gallery/Stainless.jsx';
import Epoxy from './pages/gallery/Epoxy.jsx';
import Special from './pages/gallery/Special.jsx';

// Support 관련
import SupportLayout from "./pages/support/SupportLayout.jsx";
import Notice from "./pages/support/Notice.jsx";
import Contact from "./pages/support/Contact.jsx";
import ScrollToTop from "./components/common/ScrollToTop.jsx";


function App() {


    return (
        <div className="app-wrapper">
            <Header/>
            <main className="content">

                <ScrollToTop/>
                <Routes>
                    <Route path="/" element={<Home/>}/>
                    <Route path="/support" element={<Support/>}/>

                    {/* About 중첩 라우트 */}
                    <Route path="/about" element={<AboutLayout/>}>
                        <Route path="greeting" element={<Greeting/>}/>
                        <Route path="certification" element={<Certification/>}/>
                        <Route path="Departments" element={<Departments/>}/>
                        <Route path="Equipment" element={<Equipment/>}/>
                        <Route path="Directions" element={<Directions/>}/>
                    </Route>
                    {/* Gallery 중첩 라우트 */}
                    <Route path="/gallery" element={<GalleryLayout/>}>
                        <Route path="galva" element={<Galva/>}/>
                        <Route path="stainless" element={<Stainless/>}/>
                        <Route path="epoxy" element={<Epoxy/>}/>
                        <Route path="special" element={<Special/>}/>
                    </Route>

                    {/* Support 중첩 라우트 */}
                    <Route path="/support" element={<SupportLayout/>}>
                        <Route path="Notice" element={<Notice/>}/>
                        <Route path="Contact" element={<Contact/>}/>

                    </Route>
                </Routes>

            </main>
            <Footer/>
        </div>
    )
}

export default App
