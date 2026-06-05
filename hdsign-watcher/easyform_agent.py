"""이지폼 자동입력 전용 경량 에이전트 — 워처/일러스트/플렉사인 없이.

개인 노트북(이지폼-Net 설치됨)에서 명세서 자동입력만 쓰고 싶을 때. hdsigncraft.com 명세서작성
→ [이지폼 입력] → 이 에이전트(127.0.0.1:5577)가 받아 '이지폼 자동기입 시작하기' 버튼을 띄우고,
누르면 이지폼 '매출 거래명세서' 새로작성 화면에 자동 기입한다.

사무 워처(hdsign_worksheet)와 **같은 포트(5577)·같은 엔드포인트**(/easyform/probe, /easyform/fill,
/ping)를 쓴다 → 프론트는 동일하게 동작. 워처가 떠 있는 사무실 PC에선 이걸 안 써도 됨. 개인 PC엔 이것만.
의존성: 표준 라이브러리(ctypes/tkinter/http)뿐 — easyform.py 와 함께 작은 exe 로 패키징.
"""
from __future__ import annotations

import json
import logging
import threading
import tkinter as tk
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

import easyform  # 같은 폴더의 자동기입 모듈(단일 소스 — 워처와 공유)

PORT = 5577


class _Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-HDSign-Field")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/ping":
            self._json(200, {"ok": True, "app": "hdsign_easyform_agent"})
        elif self.path == "/easyform/probe":
            self._json(200, easyform.handle_probe())
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_POST(self):  # noqa: N802
        if urlparse(self.path).path == "/easyform/fill":
            try:
                n = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(n) if n > 0 else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                self._json(400, {"staged": False, "message": "본문 파싱 실패"})
                return
            status, payload = easyform.handle_fill(body)
            self._json(status, payload)
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def log_message(self, *args, **kwargs):  # 콘솔 액세스로그 끔
        pass


def _serve():
    try:
        HTTPServer(("127.0.0.1", PORT), _Handler).serve_forever()
    except OSError as e:
        logging.warning("포트 %d 바인딩 실패(이미 사용 중? 워처가 떠 있나요): %s", PORT, e)
    except Exception as e:  # noqa: BLE001
        logging.warning("HTTP 서버 오류: %s", e)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    ORANGE = "#F57C00"       # 이지폼 컨셉(주황 + 흰글씨)
    ORANGE_DARK = "#E65100"

    root = tk.Tk()
    root.title("명세서 자동작성")
    root.resizable(False, False)
    root.geometry("460x184")
    root.configure(bg="#ffffff")
    # 상단 주황 헤더 바(로고)
    head = tk.Frame(root, bg=ORANGE, height=int(46))
    head.pack(fill="x")
    tk.Label(head, text="📝  명세서 자동작성", font=("맑은 고딕", 13, "bold"),
             fg="#ffffff", bg=ORANGE, padx=16, pady=10).pack(anchor="w")
    frame = tk.Frame(root, bg="#ffffff", padx=18, pady=14)
    frame.pack(fill="both", expand=True)
    tk.Label(frame,
             text="홈페이지에서 명세서 작성 시 자동으로 작성을 도와드립니다.\n창을 닫으면 종료됩니다.",
             font=("맑은 고딕", 11), fg="#333333", bg="#ffffff", justify="left").pack(anchor="w")
    ready = easyform.EASYFORM_AVAILABLE
    status = "✅ 이지폼 자동기입 준비됨" if ready else "⚠ 이 PC 에서는 자동기입 불가(Windows 전용)"
    tk.Label(frame, text=status, font=("맑은 고딕", 12, "bold"),
             fg=(ORANGE_DARK if ready else "#b91c1c"), bg="#ffffff").pack(anchor="w", pady=(14, 0))

    threading.Thread(target=_serve, daemon=True).start()
    logging.info("명세서 자동작성 에이전트 — http://127.0.0.1:%d 대기", PORT)
    try:
        easyform.install(root, accent=ORANGE, accent_dark=ORANGE_DARK)  # 주황 테마 버튼 UI + F6
    except Exception as e:  # noqa: BLE001
        logging.warning("이지폼 UI 설치 실패: %s", e)
    root.mainloop()


if __name__ == "__main__":
    main()
