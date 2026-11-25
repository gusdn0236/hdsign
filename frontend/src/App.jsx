import { FailCopyChip } from './components/common/FailCopy';
import './App.css'
import React, { Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
import ScrollToTop from './components/common/ScrollToTop.jsx'
import { AuthProvider } from './context/AuthContext'
import PrivateRoute from './components/common/PrivateRoute.jsx'

import { lazyWithRetry } from './utils/lazyWithRetry.js'

// 공개(About / Gallery / Support) 페이지 — Home 만 즉시 번들에 포함하고 나머지는
// 라우트 진입 시 청크 다운로드 → 첫 페이지 로딩 시간 단축. react-pdf / gsap 등은 자연스럽게
// 해당 페이지(예: WorksheetViewer, Home) 청크에만 들어가서 메인 번들이 가벼워진다.
const AboutLayout      = lazyWithRetry(() => import('./pages/about/AboutLayout.jsx'))
const Greeting         = lazyWithRetry(() => import('./pages/about/Greeting.jsx'))
const Certification    = lazyWithRetry(() => import('./pages/about/Certification.jsx'))
const Departments      = lazyWithRetry(() => import('./pages/about/Departments.jsx'))
const Equipment        = lazyWithRetry(() => import('./pages/about/Equipment.jsx'))
const Directions       = lazyWithRetry(() => import('./pages/about/Directions.jsx'))
const GalleryLayout    = lazyWithRetry(() => import('./pages/gallery/GalleryLayout.jsx'))
const Galva            = lazyWithRetry(() => import('./pages/gallery/Galva.jsx'))
const Stainless        = lazyWithRetry(() => import('./pages/gallery/Stainless.jsx'))
const Epoxy            = lazyWithRetry(() => import('./pages/gallery/Epoxy.jsx'))
const Aluminum         = lazyWithRetry(() => import('./pages/gallery/Aluminum.jsx'))
const ArtNeon          = lazyWithRetry(() => import('./pages/gallery/ArtNeon.jsx'))
const Special          = lazyWithRetry(() => import('./pages/gallery/Special.jsx'))
const SupportLayout    = lazyWithRetry(() => import('./pages/support/SupportLayout.jsx'))
const Notice           = lazyWithRetry(() => import('./pages/support/Notice.jsx'))
const Contact          = lazyWithRetry(() => import('./pages/support/Contact.jsx'))

const AdminLogin       = lazyWithRetry(() => import('./pages/admin/AdminLogin.jsx'))
const AdminLayout      = lazyWithRetry(() => import('./pages/admin/AdminLayout.jsx'))
const GalleryUpload    = lazyWithRetry(() => import('./pages/admin/GalleryUpload.jsx'))
const NoticeAdmin      = lazyWithRetry(() => import('./pages/admin/NoticeAdmin.jsx'))
const EvidenceAdmin    = lazyWithRetry(() => import('./pages/admin/EvidenceAdmin.jsx'))
const OrderAdmin       = lazyWithRetry(() => import('./pages/admin/OrderAdmin.jsx'))
const WorkStatus       = lazyWithRetry(() => import('./pages/admin/WorkStatus.jsx'))
const ProxyOrder       = lazyWithRetry(() => import('./pages/admin/ProxyOrder.jsx'))
const ClientAdmin      = lazyWithRetry(() => import('./pages/admin/ClientAdmin.jsx'))
const RatesAdmin       = lazyWithRetry(() => import('./pages/admin/RatesAdmin.jsx'))
const CasesAdmin       = lazyWithRetry(() => import('./pages/admin/CasesAdmin.jsx'))
const CalcLayout       = lazyWithRetry(() => import('./pages/admin/calc/CalcLayout.jsx'))
const SalesAnalytics   = lazyWithRetry(() => import('./pages/admin/analytics/SalesAnalytics.tsx'))
const ClientLogin      = lazyWithRetry(() => import('./pages/client/ClientLogin.jsx'))
const ClientSignup     = lazyWithRetry(() => import('./pages/client/ClientSignup.jsx'))
const ClientLayout     = lazyWithRetry(() => import('./pages/client/ClientLayout.jsx'))
const ClientRequest    = lazyWithRetry(() => import('./pages/client/ClientRequest.jsx'))
const ClientQuoteRequest = lazyWithRetry(() => import('./pages/client/ClientQuoteRequest.jsx'))
const ClientStatus     = lazyWithRetry(() => import('./pages/client/ClientStatus.jsx'))
const EvidenceQuickCapture = lazyWithRetry(() => import('./pages/evidence/EvidenceQuickCapture.jsx'))
const WorksheetList    = lazyWithRetry(() => import('./pages/mobile/WorksheetList.jsx'))
const WorksheetViewer  = lazyWithRetry(() => import('./pages/mobile/WorksheetViewer.jsx'))
const FieldViewer      = lazyWithRetry(() => import('./pages/field/FieldViewer.jsx'))
const FieldZoomViewer  = lazyWithRetry(() => import('./pages/field/FieldZoomViewer.jsx'))

const RouteFallback = () => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '60vh', color: '#71717a', fontSize: 14,
    }}>
        불러오는 중...
    </div>
)

function App() {
    const location = useLocation()
    const isAdmin  = location.pathname.startsWith('/admin')
    const isClient = location.pathname.startsWith('/client')
    const isEvidence = location.pathname.startsWith('/p/')
    const isMobileApp = location.pathname.startsWith('/m/')
    const isField = location.pathname.startsWith('/field')
    const hideHeaderFooter = isAdmin || isClient || isEvidence || isMobileApp || isField

    return (
        <AuthProvider>
            <div className="app-wrapper">
                {!hideHeaderFooter && <Header />}
                {/* 관리자·현장 — 뭔가 실패하면 왼쪽 아래 [실패 원인 복사하기] (사용자 2026-11-25) */}
                {(isAdmin || isField) && <FailCopyChip />}
                <main className="content">
                    <ScrollToTop />
                    <Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/" element={<Home />} />

                        <Route path="/about" element={<AboutLayout />}>
                            <Route path="greeting"      element={<Greeting />} />
                            <Route path="certification" element={<Certification />} />
                            <Route path="Departments"   element={<Departments />} />
                            <Route path="Equipment"     element={<Equipment />} />
                            <Route path="Directions"    element={<Directions />} />
                        </Route>

                        <Route path="/gallery" element={<GalleryLayout />}>
                            <Route path="galva"     element={<Galva />} />
                            <Route path="stainless" element={<Stainless />} />
                            <Route path="epoxy"     element={<Epoxy />} />
                            <Route path="aluminum"  element={<Aluminum />} />
                            <Route path="artneon"   element={<ArtNeon />} />
                            <Route path="special"   element={<Special />} />
                        </Route>

                        <Route path="/support" element={<SupportLayout />}>
                            <Route path="Notice"  element={<Notice />} />
                            <Route path="Contact" element={<Contact />} />
                        </Route>

                        <Route path="/admin/login" element={<AdminLogin />} />
                        <Route
                            path="/admin"
                            element={<PrivateRoute><AdminLayout /></PrivateRoute>}
                        >
                            <Route index element={<Navigate to="orders" replace />} />
                            <Route path="gallery-upload" element={<GalleryUpload />} />
                            <Route path="orders" element={<OrderAdmin requestType="ORDER" />} />
                            <Route path="work-status" element={<WorkStatus />} />
                            <Route path="quotes" element={<OrderAdmin requestType="QUOTE" />} />
                            <Route path="rates" element={<RatesAdmin />} />
                            <Route path="cases" element={<CasesAdmin />} />
                            <Route path="proxy-order" element={<ProxyOrder />} />
                            <Route path="clients" element={<ClientAdmin />} />
                            <Route path="prices" element={<CalcLayout />} />
                            <Route path="calc/*" element={<Navigate to="/admin/prices" replace />} />
                            <Route path="notices" element={<NoticeAdmin />} />
                            <Route path="evidence" element={<EvidenceAdmin />} />
                            <Route path="analytics" element={<SalesAnalytics />} />
                        </Route>

                        <Route path="/p/:orderNumber" element={<EvidenceQuickCapture />} />

                        <Route path="/m/worksheets" element={<WorksheetList />} />
                        <Route path="/m/worksheets/:orderNumber" element={<WorksheetViewer />} />

                        <Route path="/field" element={<FieldViewer />} />
                        <Route path="/field/zoom" element={<FieldZoomViewer />} />

                        <Route path="/client/login" element={<ClientLogin />} />
                        <Route path="/client/signup" element={<ClientSignup />} />
                        <Route path="/client" element={<ClientLayout />}>
                            <Route index         element={<Navigate to="request" replace />} />
                            <Route path="request" element={<ClientRequest />} />
                            <Route path="quote" element={<ClientQuoteRequest />} />
                            <Route path="status"  element={<ClientStatus />} />
                        </Route>

                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                    </Suspense>
                </main>
                {!hideHeaderFooter && <Footer />}
            </div>
        </AuthProvider>
    )
}

export default App
