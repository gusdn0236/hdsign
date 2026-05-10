import { useState } from 'react'

/**
 * 결과박스 우상단 복사 버튼.
 * text 가 falsy 면 비활성화. 클릭하면 클립보드에 복사하고 1.5초간 "복사됨" 표시.
 */
export default function CopyButton({ text }) {
    const [copied, setCopied] = useState(false)
    const disabled = !text

    const onClick = async () => {
        if (!text) return
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            // navigator.clipboard 미지원/거부 — fallback 으로 임시 textarea 사용.
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            try { document.execCommand('copy') } catch {}
            document.body.removeChild(ta)
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <button
            type="button"
            className={`calc-copy-btn ${copied ? 'copied' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={text || '값이 계산되면 복사할 수 있어요'}
        >
            {copied ? '복사됨' : '복사'}
        </button>
    )
}
