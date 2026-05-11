"""HD사인 현장 작업뷰어 — 로컬 에이전트.

웹 사이드바(/field) 의 [FS에서 열기] 버튼이 호출하는 127.0.0.1 HTTP 리스너.
주문번호를 받아 백엔드 API 로 거래처 네트워크폴더명 + 원본 PDF 파일명을 조회하고,
거래처 폴더 트리를 워킹해 동일 stem 의 .fs 파일을 찾아 FlexiSIGN 으로 실행한다.

표준 라이브러리만 사용 — PyInstaller 단일 .exe 패키징을 가볍게.
사무실 워처(hdsign-watcher) 와는 별도 프로젝트 — 네트워크 폴더 베이스만 같은 config 키 공유.
"""
from __future__ import annotations

import difflib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ─── 설정 ─────────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    # 백엔드 API 베이스. 운영/개발 모두 같은 키.
    "api_base": "https://hdsign-production.up.railway.app",
    # 사무실 워처와 동일한 키 — 같은 config 를 공유해도 안전하도록 같은 이름 사용.
    "network_customer_base": r"\\Main\공유\거래처",
    # FlexiSIGN 실행파일. 환경마다 경로가 다를 수 있어 첫 실행 시 검증.
    "flexisign_exe": r"C:\Program Files\SAi\Production Suite\Cloud\FlexiSign Pro\FlexiSign.exe",
    # 로컬 리스너 포트. 17345 = 1234 의 키보드 우측 시프트 — 충돌 가능성 매우 낮음.
    "port": 17345,
    # CORS 허용 origin. 운영 도메인 + 로컬 개발(http://localhost:5173) 권장.
    # 정확 일치만 허용 — 와일드카드(*) 는 보안상 비추천(아무 사이트에서 호출 가능).
    "allowed_origins": [
        "https://hdsigncraft.com",
        "https://www.hdsigncraft.com",
        "http://localhost:5173",
    ],
    # .fs stem 유사도 폴백 임계값(0~1). 0.85 = 글자 85% 유사할 때만 자동 채택.
    "fuzzy_threshold": 0.85,
}


def _config_path() -> Path:
    """실행파일과 같은 폴더의 config.json. PyInstaller --onefile 도 _MEIPASS 가 아니라
    실제 .exe 옆을 봐야 사용자가 편집 가능."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "config.json"
    return Path(__file__).resolve().parent / "config.json"


def load_config() -> dict:
    path = _config_path()
    config = dict(DEFAULT_CONFIG)
    if path.exists():
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                config.update(user)
        except Exception as e:
            logging.warning("config.json 파싱 실패 — 기본값 사용: %s", e)
    else:
        # 첫 실행 시 템플릿 생성 — 사용자가 바로 편집 가능.
        try:
            path.write_text(
                json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            logging.info("기본 config.json 생성: %s", path)
        except Exception as e:
            logging.warning("기본 config.json 생성 실패: %s", e)
    return config


# ─── 거래처 폴더 매칭 (워처 로직 단순화 버전) ───────────────────────────────

def _normalize_key(value: str) -> str:
    """거래처/폴더명 비교용 정규화. NFC + 소문자 + 모든 공백 제거.
    워처의 _normalize_company_key 와 같은 의도(공백/대소문자/유니코드 합성 차이를 무시)."""
    if not value:
        return ""
    norm = unicodedata.normalize("NFC", value).strip().lower()
    return re.sub(r"\s+", "", norm)


def find_customer_folder(network_base: Path, network_folder_name: str,
                         company_name: str) -> Path | None:
    """네트워크 베이스에서 거래처 폴더 찾기. 1순위 networkFolderName, 2순위 companyName.
    못 찾으면 None — 호출자가 [거래처 폴더 못 찾음] 토스트 띄우게 함."""
    primary = _normalize_key(network_folder_name)
    fallback = _normalize_key(company_name)
    if not primary and not fallback:
        return None
    try:
        if not network_base.exists():
            logging.warning("네트워크 베이스 접근 불가: %s", network_base)
            return None
        primary_hit = None
        fallback_hit = None
        for child in network_base.iterdir():
            if not child.is_dir():
                continue
            key = _normalize_key(child.name)
            if primary and key == primary:
                primary_hit = child
                break  # 1순위 발견 즉시 종료
            if fallback and key == fallback and fallback_hit is None:
                fallback_hit = child
        return primary_hit or fallback_hit
    except Exception as e:
        logging.warning("거래처 폴더 스캔 실패: %s", e)
        return None


# 인쇄 작업명에 앱이 붙이는 접두사 — PDF24 가 $fileName 으로 받으면 그대로 PDF 명이 됨.
# 예: FlexiSIGN 은 "FlexiSIGN - 간판_베리하운드최종" 으로 보냄 → .fs 는 "간판_베리하운드최종.fs".
# 매칭 전에 이런 접두사를 벗긴 후보도 함께 시도한다(원본 stem 도 그대로 시도하므로 손해 없음).
_PRINT_JOB_PREFIX_RE = re.compile(r"^\s*(?:flexisign|flexsign|adobe illustrator|illustrator)\s*[-–—:]\s*",
                                  re.IGNORECASE)


def _stem_candidates(pdf_stem: str) -> list[str]:
    """매칭에 쓸 stem 후보들 — 원본 + 알려진 인쇄앱 접두사 제거본. 중복/빈값 제거."""
    out = [pdf_stem]
    stripped = _PRINT_JOB_PREFIX_RE.sub("", pdf_stem).strip()
    if stripped and stripped != pdf_stem:
        out.append(stripped)
    return out


def find_fs_file(customer_folder: Path, pdf_filename: str,
                 fuzzy_threshold: float) -> tuple[Path | None, str]:
    """거래처 폴더 트리에서 .fs 파일 찾기.

    매칭 단계:
      1. 정확 매칭 — `<pdf_stem>.fs` 가 그대로 있는 경우 (대다수). pdf_stem 은 원본 + 인쇄앱
         접두사("FlexiSIGN - " 등) 제거본 둘 다 시도.
      2. 유사 매칭 — 같은 폴더(또는 어디든) 의 .fs 파일들 중 stem 유사도(공백/특수
         문자 정규화 후 SequenceMatcher) 가 임계값 이상 + 후보 단일이면 자동 채택
      3. 둘 다 실패 → (None, 사유)

    여러 .fs 가 동일 stem 으로 있으면 가장 최근 수정된 것을 채택(같은 작업의
    버전관리 케이스). 반환: (Path 또는 None, 이유 텍스트)."""
    if not pdf_filename:
        return None, "원본 PDF 파일명이 없습니다."
    pdf_stem = Path(pdf_filename).stem
    if not pdf_stem:
        return None, "PDF 파일명에서 stem 을 추출하지 못했습니다."

    target_keys = [_normalize_key(s) for s in _stem_candidates(pdf_stem)]
    target_keys = [k for k in target_keys if k]
    exact_matches: list[Path] = []
    fuzzy_pool: list[tuple[float, Path]] = []
    try:
        for fs in customer_folder.rglob("*.fs"):
            if not fs.is_file():
                continue
            fs_key = _normalize_key(fs.stem)
            if fs_key in target_keys:
                exact_matches.append(fs)
                continue
            ratio = max(difflib.SequenceMatcher(None, fs_key, tk).ratio() for tk in target_keys)
            if ratio >= fuzzy_threshold:
                fuzzy_pool.append((ratio, fs))
    except Exception as e:
        return None, f"폴더 탐색 실패: {e}"

    if exact_matches:
        # 정확 stem 동일 .fs 가 여러 개 — 가장 최근 수정본 채택.
        best = max(exact_matches, key=lambda p: p.stat().st_mtime)
        return best, "exact"

    if fuzzy_pool:
        fuzzy_pool.sort(key=lambda x: (-x[0], -x[1].stat().st_mtime))
        # 1위와 2위가 모두 임계값 이상이면 모호 — 사용자에게 선택권을 주려고 폴더만 열기.
        if len(fuzzy_pool) >= 2 and fuzzy_pool[0][0] - fuzzy_pool[1][0] < 0.05:
            return None, f"유사 .fs 후보가 여러 개({len(fuzzy_pool)}건) — 거래처 폴더를 엽니다."
        return fuzzy_pool[0][1], f"fuzzy({fuzzy_pool[0][0]:.0%})"

    return None, f"동일 stem 의 .fs 를 찾지 못했습니다: {pdf_stem}.fs"


# ─── FlexiSIGN 실행 ─────────────────────────────────────────────────────

def launch_flexisign(exe_path: str, fs_file: Path) -> tuple[bool, str]:
    exe = Path(exe_path)
    if not exe.exists():
        return False, f"FlexiSIGN 실행파일이 없습니다: {exe_path}"
    try:
        subprocess.Popen([str(exe), str(fs_file)], close_fds=True)
        return True, str(fs_file)
    except Exception as e:
        return False, f"FlexiSIGN 실행 실패: {e}"


def open_folder_in_explorer(folder: Path) -> None:
    """매칭 실패 시 거래처 폴더를 탐색기로 열어 사용자가 수동 선택하게 함."""
    try:
        os.startfile(str(folder))  # Windows 전용 — Mac/Linux 미지원이지만 현장은 Windows.
    except Exception as e:
        logging.warning("폴더 열기 실패: %s", e)


# ─── 백엔드 API ─────────────────────────────────────────────────────────

def fetch_worksheet(api_base: str, order_number: str) -> dict | None:
    url = f"{api_base.rstrip('/')}/api/public/worksheets/{urllib.parse.quote(order_number, safe='')}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, dict) else None
    except Exception as e:
        logging.warning("API 조회 실패 [%s]: %s", order_number, e)
        return None


# ─── HTTP 핸들러 ───────────────────────────────────────────────────────

class FieldAgentHandler(BaseHTTPRequestHandler):
    config: dict = {}  # 클래스 속성으로 주입(모듈 시작 시).

    # access log 줄이기 — 기본 BaseHTTPRequestHandler 가 매 요청 stderr 에 라인 찍음.
    def log_message(self, format, *args):
        logging.info("%s - %s", self.address_string(), format % args)

    def _origin_allowed(self) -> str | None:
        """요청 origin 이 화이트리스트에 있으면 그 값 반환, 아니면 None."""
        origin = self.headers.get("Origin", "")
        allowed = self.config.get("allowed_origins") or []
        if origin and origin in allowed:
            return origin
        return None

    def _send_cors(self, origin: str | None) -> None:
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-HDSign-Field")
            self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, status: int, payload: dict, origin: str | None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors(origin)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self._origin_allowed()
        # Origin 화이트리스트 밖이면 204 + CORS 헤더 생략 → 브라우저가 본 요청 차단.
        self.send_response(204)
        self._send_cors(origin)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            origin = self._origin_allowed()
            self._send_json(200, {"ok": True, "version": 1}, origin)
            return
        # /open 은 비-단순(custom header) POST 만 허용 → CSRF 노출 최소화.
        # 그래도 GET 으로 들어오는 단순 fetch 케이스를 친절히 안내.
        if parsed.path == "/open":
            origin = self._origin_allowed()
            self._send_json(405, {"message": "POST 로 호출하세요."}, origin)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        origin = self._origin_allowed()
        if origin is None:
            # 화이트리스트 밖 origin — CSRF 의심 차단.
            self.send_response(403)
            self.end_headers()
            return
        if parsed.path != "/open":
            self.send_response(404)
            self._send_cors(origin)
            self.end_headers()
            return

        # custom header 검사 — preflight 우회 시도 차단(X-HDSign-Field 가 없으면 거부).
        if self.headers.get("X-HDSign-Field") != "1":
            self._send_json(400, {"message": "X-HDSign-Field 헤더 필요"}, origin)
            return

        order_number = ""
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b""
            if raw:
                body = json.loads(raw.decode("utf-8"))
                if isinstance(body, dict):
                    order_number = (body.get("orderNumber") or "").strip()
        except Exception:
            pass
        # 쿼리스트링도 보조 — 디버깅 시 brower url bar 로 호출하려는 경우(CORS 통과는 안 되지만).
        if not order_number:
            qs = urllib.parse.parse_qs(parsed.query)
            order_number = (qs.get("orderNumber", [""])[0]).strip()
        if not order_number:
            self._send_json(400, {"message": "orderNumber 가 필요합니다."}, origin)
            return

        result = self.process_open(order_number)
        status = 200 if result.get("opened") else 200  # 200 + opened=false 로 통일(웹은 메시지로 분기)
        self._send_json(status, result, origin)

    def process_open(self, order_number: str) -> dict:
        config = self.config
        api_base = (config.get("api_base") or "").strip()
        network_base_str = (config.get("network_customer_base") or "").strip()
        flexisign_exe = (config.get("flexisign_exe") or "").strip()
        fuzzy_threshold = float(config.get("fuzzy_threshold") or 0.85)

        if not api_base:
            return {"opened": False, "message": "config.json 의 api_base 가 설정되지 않았습니다."}
        if not network_base_str:
            return {"opened": False, "message": "config.json 의 network_customer_base 가 설정되지 않았습니다."}
        if not flexisign_exe:
            return {"opened": False, "message": "config.json 의 flexisign_exe 가 설정되지 않았습니다."}

        meta = fetch_worksheet(api_base, order_number)
        if not meta:
            return {"opened": False, "message": f"백엔드에서 [{order_number}] 정보를 가져오지 못했습니다."}

        company = (meta.get("companyName") or "").strip()
        network_folder_name = (meta.get("networkFolderName") or "").strip()
        pdf_filename = (meta.get("originalPdfFilename") or "").strip()
        if not pdf_filename:
            return {"opened": False, "message": "이 지시서엔 원본 PDF 파일명이 없습니다 — 워처가 새로 인쇄해야 활성됩니다."}
        if not network_folder_name and not company:
            return {"opened": False, "message": "거래처 정보가 비어있어 폴더를 찾을 수 없습니다."}

        network_base = Path(network_base_str)
        customer_folder = find_customer_folder(network_base, network_folder_name, company)
        if customer_folder is None:
            return {
                "opened": False,
                "message": f"거래처 폴더를 찾지 못했습니다: {network_folder_name or company}",
            }

        fs_file, reason = find_fs_file(customer_folder, pdf_filename, fuzzy_threshold)
        if fs_file is None:
            # 폴더 자체를 열어 사용자가 수동으로 선택하게 폴백.
            open_folder_in_explorer(customer_folder)
            return {
                "opened": False,
                "message": f"{reason} 거래처 폴더를 열었습니다.",
                "customerFolder": str(customer_folder),
            }

        ok, info = launch_flexisign(flexisign_exe, fs_file)
        if not ok:
            return {"opened": False, "message": info}
        logging.info("FS 실행 [%s] → %s (%s)", order_number, fs_file.name, reason)
        return {
            "opened": True,
            "matchedFile": fs_file.name,
            "matchKind": reason,
            "customerFolder": str(customer_folder),
        }


# ─── 메인 ────────────────────────────────────────────────────────────────

def serve_forever(config: dict) -> None:
    port = int(config.get("port") or 17345)
    FieldAgentHandler.config = config
    # 127.0.0.1 바인딩 — 동일 PC 의 브라우저만 접근. LAN 의 다른 PC 가 호출 불가.
    server = ThreadingHTTPServer(("127.0.0.1", port), FieldAgentHandler)
    logging.info("HD사인 작업뷰어 에이전트 — http://127.0.0.1:%d 에서 대기 중", port)
    logging.info("API 베이스: %s", config.get("api_base"))
    logging.info("네트워크 베이스: %s", config.get("network_customer_base"))
    logging.info("FlexiSIGN: %s", config.get("flexisign_exe"))
    logging.info("허용 origin: %s", ", ".join(config.get("allowed_origins") or []))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("종료 요청 — 서버 정리")
    finally:
        server.server_close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    config = load_config()
    serve_forever(config)


if __name__ == "__main__":
    main()
