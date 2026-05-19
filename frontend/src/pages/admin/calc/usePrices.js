/**
 * 단가 데이터 — 백엔드의 라이브 prices.json (admin 이 갱신한 최신) 을 fetch.
 * 백엔드가 안 떠있거나 fetch 실패하면 빌드 번들의 정적 prices.json 으로 폴백.
 *
 * 가격 갱신 흐름:
 *   1) admin 이 /admin/prices 에서 엑셀 업로드 + 셀별 review 후 [반영]
 *   2) 백엔드가 prices.json 을 디스크에 저장 (자동 .bak 백업)
 *   3) 계산기 페이지가 새로고침되면 fetch 로 새 가격을 즉시 받음
 *      (git commit + 재배포 불필요)
 */
import { useState, useEffect } from 'react'
import staticPrices from '../../../data/calc/prices.json'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export function usePrices() {
    const [prices, setPrices] = useState(null)
    const [error, setError] = useState(null)

    useEffect(() => {
        let alive = true
        fetch(`${BASE_URL}/api/public/calc-prices`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json()
            })
            .then(data => { if (alive) setPrices(data) })
            .catch(e => {
                if (!alive) return
                // 백엔드 죽어도 계산기는 멈추면 안 됨 — 정적 baseline 으로 폴백
                // eslint-disable-next-line no-console
                console.warn('[usePrices] 라이브 가격 fetch 실패, 정적 prices.json 폴백:', e)
                setPrices(staticPrices)
                setError(String(e))
            })
        return () => { alive = false }
    }, [])

    return { prices, error }
}
