import './App.css'
import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
import AboutLayout from './pages/about/AboutLayout.jsx'
import Greeting from './pages/about/Greeting.jsx'
import Certification from './pages/about/Certification.jsx'
import Departments from './pages/about/Departments.jsx'
import Equipment from './pages/about/Equipment.jsx'
import Directions from './pages/about/Directions.jsx'
import GalleryLayout from './pages/gallery/GalleryLayout.jsx'
import Galva from './pages/gallery/Galva.jsx'
import Stainless from './pages/gallery/Stainless.jsx'
import Epoxy from './pages/gallery/Epoxy.jsx'
import Special from './pages/gallery/Special.jsx'
import SupportLayout from './pages/support/SupportLayout.jsx'
import Notice from './pages/support/Notice.jsx'
import Contact from './pages/support/Contact.jsx'
import ScrollToTop from './components/common/ScrollToTop.jsx'
import { AuthProvider } from './context/AuthContext'
import PrivateRoute from './components/common/PrivateRoute.jsx'

// 배포 시마다 chunk 해시가 바뀐다. 옛 index.html 을 캐싱한 사용자가 옛 chunk 를 fetch 하면
// 404 가 나면서 "Failed to fetch dynamically imported module" 로 빈 화면이 뜬다.
// 2단계 복구:
//   1차: 캐시버스터 쿼리(?_cb=ts) + navigate. SW 의 'cache: reload' HTML fetch 와 결합돼
//        대부분 케이스가 여기서 해결된다.
//   2차: SW 자체와 모든 Cache Storage 를 폐기 후 reload. 옛 SW(v1) 가 옛 index.html 을
//        들고 있어 1차 reload 가 같은 옛 chunk 해시로 돌아가는 드문 케이스 회피.
// sessionStorage 키로 단계별 가드 → 무한 새로고침 루프 방지.
const RELOAD_KEY = 'chunk-load-reloaded'
const HARD_RESET_KEY = 'chunk-load-hard-reset'
const CB_PARAM = '_cb'

function navigateWithCacheBust() {
    try {
        const url = new URL(window.location.href)
        url.searchParams.set(CB_PARAM, Date.now().toString())
        window.location.replace(url.toString())
    } catch {
        window.location.reload()
    }
}

async function nukeServiceWorkerAndCaches() {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations()
            await Promise.all(regs.map((r) => r.unregister()))
        }
    } catch { /* ignore */ }
    try {
        if ('caches' in window) {
            const keys = await caches.keys()
            await Promise.all(keys.map((k) => caches.delete(k)))
        }
    } catch { /* ignore */ }
}

const lazyWithRetry = (factory) =>
    lazy(async () => {
        try {
            const mod = await factory()
            // 성공했으면 retry 플래그 정리 + URL 에 _cb 가 남아있으면 깨끗이 제거
            if (
                window.sessionStorage.getItem(RELOAD_KEY) ||
                window.sessionStorage.getItem(HARD_RESET_KEY)
            ) {
                window.sessionStorage.removeItem(RELOAD_KEY)
                window.sessionStorage.removeItem(HARD_RESET_KEY)
                try {
                    const cleanUrl = new URL(window.location.href)
                    if (cleanUrl.searchParams.has(CB_PARAM)) {
                        cleanUrl.searchParams.delete(CB_PARAM)
                        window.history.replaceState(null, '', cleanUrl.toString())
                    }
                } catch { /* ignore */ }
            }
            return mod
        } catch (err) {
            // 1차 — 단순 캐시버스터 reload
            if (!window.sessionStorage.getItem(RELOAD_KEY)) {
                window.sessionStorage.setItem(RELOAD_KEY, '1')
                navigateWithCacheBust()
                return { default: () => null }
            }
            // 2차 — SW + Cache Storage 폐기 후 reload
            if (!window.sessionStorage.getItem(HARD_RESET_KEY)) {
                window.sessionStorage.setItem(HARD_RESET_KEY, '1')
                await nukeServiceWorkerAndCaches()
                navigateWithCacheBust()
                return { default: () => null }
            }
            // 3차 — 그래도 실패. 진짜로 청크가 없거나 네트워크가 끊긴 상태.
            throw err
        }
    })

const AdminLogin       = lazyWithRetry(() => import('./pages/admin/AdminLogin.jsx'))
const AdminLayout      = lazyWithRetry(() => import('./pages/admin/AdminLayout.jsx'))
const GalleryUpload    = lazyWithRetry(() => import('./pages/admin/GalleryUpload.jsx'))
const NoticeAdmin      = lazyWithRetry(() => import('./pages/admin/NoticeAdmin.jsx'))
const OrderAdmin       = lazyWithRetry(() => import('./pages/admin/OrderAdmin.jsx'))
const ClientAdmin      = lazyWithRetry(() => import('./pages/admin/ClientAdmin.jsx'))
const ClientLogin      = lazyWithRetry(() => import('./pages/client/ClientLogin.jsx'))
const ClientSignup     = lazyWithRetry(() => import('./pages/client/ClientSignup.jsx'))
const ClientLayout     = lazyWithRetry(() => import('./pages/client/ClientLayout.jsx'))
const ClientRequest    = lazyWithRetry(() => import('./pages/client/ClientRequest.jsx'))
const ClientQuoteRequest = lazyWithRetry(() => import('./pages/client/ClientQuoteRequest.jsx'))
const ClientStatus     = lazyWithRetry(() => import('./pages/client/ClientStatus.jsx'))
const EvidenceCapture  = lazyWithRetry(() => import('./pages/evidence/EvidenceCapture.jsx'))
const WorksheetList    = lazyWithRetry(() => import('./pages/mobile/WorksheetList.jsx'))
const WorksheetViewer  = lazyWithRetry(() => import('./pages/mobile/WorksheetViewer.jsx'))

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
    const hideHeaderFooter = isAdmin || isClient || isEvidence || isMobileApp

    return (
        <AuthProvider>
            <div className="app-wrapper">
                {!hideHeaderFooter && <Header />}
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
                            <Route path="orders" element={<OrderAdmin />} />
                            <Route path="clients" element={<ClientAdmin />} />
                            <Route path="notices" element={<NoticeAdmin />} />
                        </Route>

                        <Route path="/p/:orderNumber" element={<EvidenceCapture />} />

                        <Route path="/m/worksheets" element={<WorksheetList />} />
                        <Route path="/m/worksheets/:orderNumber" element={<WorksheetViewer />} />

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
