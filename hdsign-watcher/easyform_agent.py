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
from urllib.parse import parse_qs, urlparse

import easyform  # 같은 폴더의 자동기입 모듈(단일 소스 — 워처와 공유)

PORT = 5577

# 빌드 버전 — build_easyform_agent.py 가 빌드 직전에 _agent_build.py 를 만들어 박는다.
# 홈페이지(HD프로그램 다운로드)가 /ping 의 version 을 최신 배포본(downloads/easyform-agent-version.json)과
# 비교해 다르면 '업데이트 필요' 를 띄운다. 직접 python 으로 돌리면 'dev'.
try:
    from _agent_build import BUILD_VERSION
except Exception:  # noqa: BLE001
    BUILD_VERSION = "dev"


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
            self._json(200, {"ok": True, "app": "hdsign_easyform_agent", "version": BUILD_VERSION})
        elif self.path == "/easyform/probe":
            self._json(200, easyform.handle_probe())
        elif self.path.startswith("/easyform/autosync"):
            import easyform_autosync
            try:
                after = int((parse_qs(urlparse(self.path).query).get("after") or ["0"])[0] or 0)
            except ValueError:
                after = 0
            self._json(200, easyform_autosync.handle_events(after))
        elif self.path.startswith("/easyform/bulk"):
            # 이지폼 일괄 가져오기(명세서 탭) — 진행/결과 폴링
            import easyform_bulk
            from urllib.parse import urlparse as _bu, parse_qs as _bq
            try:
                bid = int((_bq(_bu(self.path).query).get("id") or ["0"])[0] or 0)
            except ValueError:
                bid = 0
            self._json(200, easyform_bulk.handle_status(bid))
        elif self.path.startswith("/easyform/pull"):
            try:
                pid = int((parse_qs(urlparse(self.path).query).get("id") or ["0"])[0] or 0)
            except ValueError:
                pid = 0
            self._json(200, easyform.handle_pull_status(pid))
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/easyform/pull":
            # body = {} (상세명세서 1건 가져오기) 또는 {mode:'scan', stopBefore, max} (목록에서 찾기)
            try:
                n = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(n) if n > 0 else b""
                pbody = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                pbody = {}
            self._json(*easyform.handle_pull_start(pbody))
            return
        if parsed.path.startswith("/easyform/autosync/"):
            import easyform_autosync
            try:
                n = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(n) if n > 0 else b""
                abody = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                abody = {}
            act = parsed.path.rsplit("/", 1)[-1]
            aq = parse_qs(parsed.query)
            try:
                aid = int((aq.get("id") or ["0"])[0] or 0)
            except ValueError:
                aid = 0
            atab = (aq.get("tab") or [""])[0][:40]
            if act == "claim":
                self._json(200, easyform_autosync.handle_claim(aid, atab))
            elif act == "release":
                self._json(200, easyform_autosync.handle_release(aid, atab))
            elif act == "back":
                self._json(200, easyform_autosync.handle_back(aid))
            elif act == "front":
                self._json(200, easyform_autosync.handle_front(abody))
            elif act == "stamp":
                self._json(200, easyform_autosync.handle_stamp(abody))
            else:
                self._json(404, {"ok": False})
            return
        if parsed.path == "/easyform/bulk":
            import easyform_bulk
            try:
                n = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(n) if n > 0 else b""
                bbody = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                bbody = {}
            self._json(*easyform_bulk.handle_start(bbody))
            return
        if parsed.path == "/easyform/bulk/pause":
            import easyform_bulk
            q = parse_qs(parsed.query)
            try:
                bid = int((q.get("id") or ["0"])[0] or 0)
            except ValueError:
                bid = 0
            self._json(200, easyform_bulk.handle_pause(bid, (q.get("on") or ["1"])[0] == "1"))
            return
        if parsed.path == "/easyform/bulk/cancel":
            import easyform_bulk
            try:
                bid = int((parse_qs(parsed.query).get("id") or ["0"])[0] or 0)
            except ValueError:
                bid = 0
            self._json(200, easyform_bulk.handle_cancel(bid))
            return
        if parsed.path == "/easyform/pull/cancel":
            try:
                pid = int((parse_qs(parsed.query).get("id") or ["0"])[0] or 0)
            except ValueError:
                pid = 0
            self._json(200, easyform.handle_pull_cancel(pid))
            return
        if parsed.path == "/easyform/fill":
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
    root.title(f"명세서 자동작성  (버전 {BUILD_VERSION})")
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
    try:
        import easyform_autosync  # 이지폼 '매출 거래명세서' [저장] 감지 → 홈페이지 반영(묻고, 예일 때만)
        easyform_autosync.start()
    except Exception as e:  # noqa: BLE001
        logging.warning("이지폼 저장 자동반영 시작 실패: %s", e)
    root.mainloop()


if __name__ == "__main__":
    main()
