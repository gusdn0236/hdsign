import { useEffect, useState } from 'react'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/**
 * 단가 데이터 로드 훅. 공개 엔드포인트(/api/public/calc-prices)를 사용 — 인증 없이 호출.
 * prices.json 이 아직 없으면 백엔드가 baseline 으로 폴백하므로 첫 배포 직후에도 동작.
 */
export function usePrices() {
    const [prices, setPrices] = useState(null)
    const [error, setError] = useState(null)

    useEffect(() => {
        fetch(`${BASE_URL}/api/public/calc-prices`)
            .then(async r => {
                if (r.ok) return r.json()
                const body = await r.text().catch(() => '')
                throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`)
            })
            .then(setPrices)
            .catch(e => setError(String(e.message || e)))
    }, [])

    return { prices, error }
}
