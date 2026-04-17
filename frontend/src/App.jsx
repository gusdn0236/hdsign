import './App.css'
import React from 'react'
import {Routes, Route} from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
import Gallery from './pages/Gallery.jsx'
import Support from './pages/Support.jsx'
import AboutLayout from './pages/about/AboutLayout.jsx'
import Greeting from './pages/about/Greeting.jsx'
import Certification from './pages/about/Certification.jsx'
import Departments from './pages/about/Departments.jsx'
import Equipment from './pages/about/Equipment.jsx'
import Directions from './pages/about/Directions.jsx'
import GalleryLayout from "./pages/gallery/GalleryLayout.jsx"
import Galva from "./pages/gallery/Galva.jsx"
import Stainless from './pages/gallery/Stainless.jsx'
import Epoxy from './pages/gallery/Epoxy.jsx'
import Special from './pages/gallery/Special.jsx'
import SupportLayout from "./pages/support/SupportLayout.jsx"
import Notice from "./pages/support/Notice.jsx"
import Contact from "./pages/support/Contact.jsx"
import ScrollToTop from "./components/common/ScrollToTop.jsx"
import { AuthProvider } from "./context/AuthContext"
import PrivateRoute from "./components/common/PrivateRoute.jsx"
import AdminLogin from "./pages/admin/AdminLogin.jsx"
import GalleryUpload from "./pages/admin/GalleryUpload.jsx"

function App() {
    return (
        <AuthProvider>
        <div className="app-wrapper">
            <Header/>
            <main className="content">
                <ScrollToTop/>
                <Routes>
                    <Route path="/" element={<Home/>}/>
                    <Route path="/support" element={<Support/>}/>
                    <Route path="/about" element={<AboutLayout/>}>
                        <Route path="greeting" element={<Greeting/>}/>
                        <Route path="certification" element={<Certification/>}/>
                        <Route path="Departments" element={<Departments/>}/>
                        <Route path="Equipment" element={<Equipment/>}/>
                        <Route path="Directions" element={<Directions/>}/>
                    </Route>
                    <Route path="/gallery" element={<GalleryLayout/>}>
                        <Route path="galva" element={<Galva/>}/>
                        <Route path="stainless" element={<Stainless/>}/>
                        <Route path="epoxy" element={<Epoxy/>}/>
                        <Route path="special" element={<Special/>}/>
                    </Route>
                    <Route path="/support" element={<SupportLayout/>}>
                        <Route path="Notice" element={<Notice/>}/>
                        <Route path="Contact" element={<Contact/>}/>
                    </Route>
                    <Route path="/admin/login" element={<AdminLogin/>}/>
                    <Route path="/admin/gallery-upload" element={
                        <PrivateRoute><GalleryUpload/></PrivateRoute>
                    }/>
                </Routes>
            </main>
            <Footer/>
        </div>
        </AuthProvider>
    )
}
export default App