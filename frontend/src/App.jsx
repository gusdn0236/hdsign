import './App.css'
import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Header from './components/common/Header.jsx'
import Footer from './components/common/Footer.jsx'
import Home from './pages/Home.jsx'
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
const CalcLayout       = lazyWithRetry(() => import('./pages/admin/calc/CalcLayout.jsx'))
const ClientLogin      = lazyWithRetry(() => import('./pages/client/ClientLogin.jsx'))
const ClientSignup     = lazyWithRetry(() => import('./pages/client/ClientSignup.jsx'))
const ClientLayout     = lazyWithRetry(() => import('./pages/client/ClientLayout.jsx'))
const ClientRequest    = lazyWithRetry(() => import('./pages/client/ClientRequest.jsx'))
const ClientQuoteRequest = lazyWithRetry(() => import('./pages/client/ClientQuoteRequest.jsx'))
const ClientStatus     = lazyWithRetry(() => import('./pages/client/ClientStatus.jsx'))
const EvidenceCapture  = lazyWithRetry(() => import('./pages/evidence/EvidenceCapture.jsx'))
const WorksheetList    = lazyWithRetry(() => import('./pages/mobile/WorksheetList.jsx'))
const WorksheetViewer  = lazyWithRetry(() => import('./pages/mobile/WorksheetViewer.jsx'))
const FieldViewer      = lazyWithRetry(() => import('./pages/field/FieldViewer.jsx'))

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
                            <Route path="proxy-order" element={<ProxyOrder />} />
                            <Route path="clients" element={<ClientAdmin />} />
                            <Route path="prices" element={<CalcLayout />} />
                            <Route path="calc/*" element={<Navigate to="/admin/prices" replace />} />
                            <Route path="notices" element={<NoticeAdmin />} />
                            <Route path="evidence" element={<EvidenceAdmin />} />
                        </Route>

                        <Route path="/p/:orderNumber" element={<EvidenceCapture />} />

                        <Route path="/m/worksheets" element={<WorksheetList />} />
                        <Route path="/m/worksheets/:orderNumber" element={<WorksheetViewer />} />

                        <Route path="/field" element={<FieldViewer />} />

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
