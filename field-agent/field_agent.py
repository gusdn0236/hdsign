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
import ssl
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ─── HTTPS 인증서 컨텍스트 ────────────────────────────────────────────────
# 시스템(윈도우) 인증서 저장소 + certifi 번들을 둘 다 신뢰 목록에 넣는다.
# 일부 현장 PC 가 윈도우 인증서 저장소에 Railway 인증서 체인의 루트/중간 CA 가 없어
# `[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate` 로 백엔드
# 조회가 실패하는 사례가 있어서, certifi(모질라 CA 번들)를 함께 실어 PC 와 무관하게 통하게 한다.
SSL_CONTEXT = ssl.create_default_context()
try:
    import certifi  # PyInstaller 가 cacert.pem 까지 번들. 개발/설치 안 됐으면 except 로 폴백.
    SSL_CONTEXT.load_verify_locations(certifi.where())
except Exception:  # noqa: BLE001 — certifi 없으면 시스템 인증서만으로 진행
    pass

# ─── 설정 ─────────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    # 백엔드 API 베이스. 운영/개발 모두 같은 키.
    "api_base": "https://hdsign-production.up.railway.app",
    # 사무실 워처와 동일한 키 — 같은 config 를 공유해도 안전하도록 같은 이름 사용.
    "network_customer_base": r"\\Main\현대공유\00000 2026년 자료\000 2026년 거래처",
    # FlexiSIGN 실행파일. 빈 문자열("") 이거나 경로가 존재하지 않으면 자동 탐지
    # (레지스트리의 .fs 연결 프로그램 → SAi 설치폴더 글롭). PC마다 설치 경로가 달라도
    # 보통 그대로 두면 됨. 강제 지정이 필요한 예외 PC에서만 채운다.
    # ※ 에이전트는 절대 FlexiSIGN 을 새로 띄우지 않는다 — 이미 떠 있는 FlexiSIGN 에서만
    #   파일을 연다(켜져 있지 않으면 "먼저 켜세요" 안내). exe 경로는 "그 프로세스가 떠 있나"
    #   확인용 + 시작 로그용으로만 쓰인다.
    "flexisign_exe": "",
    # FlexiSIGN 실행 여부를 확인할 프로세스 이미지명. 비어 있으면 flexisign_exe(자동탐지 포함)
    # 의 파일명을 쓰고, 그것도 없으면 기본 후보군(FlexiSign.exe / Flexi.exe / App.exe)으로 확인.
    "flexisign_process_name": "",
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


def _local_config_path() -> Path:
    """PC별 오버라이드 — 공유 config.json 위에 이 PC만의 값(주로 flexisign_exe)을 덮어쓴다.
    예: %LOCALAPPDATA%\\HDSignFieldViewer\\config.local.json 에
        {"flexisign_exe": "D:\\\\SAi\\\\...\\\\FlexiSign.exe"} 한 줄."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "HDSignFieldViewer" / "config.local.json"


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
    # PC별 오버라이드(있으면) — 공유 config 위에 덮어쓴다.
    local_path = _local_config_path()
    if local_path.exists():
        try:
            local = json.loads(local_path.read_text(encoding="utf-8"))
            if isinstance(local, dict):
                config.update(local)
                logging.info("로컬 오버라이드 적용: %s", local_path)
        except Exception as e:
            logging.warning("config.local.json 파싱 실패 — 무시: %s", e)
    if not path.exists():
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


_COMPANY_CONTACT_SUFFIX_RE = re.compile(r"^(?P<company>.+?)\((?P<contact>[^()]{1,50})\)\s*$")


def _split_company_contact_label(value: str) -> tuple[str, str]:
    raw = (value or "").strip()
    if not raw:
        return "", ""
    match = _COMPANY_CONTACT_SUFFIX_RE.match(raw)
    if not match:
        return raw, ""
    company = match.group("company").strip()
    contact = match.group("contact").strip()
    return company or raw, contact


def _customer_folder_name_candidates(network_folder_name: str, company_name: str) -> list[str]:
    """매칭 후보 — networkFolderName/companyName 그대로 + "회사명(담당자)" 꼴이면 회사명만 분리한 것도.
    중복(_normalize_key 기준) 제거. 우선순위는 입력 순서."""
    candidates: list[str] = []
    seen: set[str] = set()
    for raw in (network_folder_name, company_name):
        raw = (raw or "").strip()
        root, _contact = _split_company_contact_label(raw)
        for name in (root, raw):
            key = _normalize_key(name)
            if key and key not in seen:
                candidates.append(name.strip())
                seen.add(key)
    return candidates


def find_customer_folder(network_base: Path, network_folder_name: str,
                         company_name: str) -> Path | None:
    """네트워크 베이스에서 거래처 폴더 찾기. 1순위 networkFolderName, 2순위 companyName.
    "회사명(담당자)" 꼬리표 케이스도 회사명만으로 한 번 더 시도.
    못 찾으면 None — 호출자가 [거래처 폴더 못 찾음] 토스트 띄우게 함."""
    candidates = _customer_folder_name_candidates(network_folder_name, company_name)
    candidate_keys = [_normalize_key(name) for name in candidates]
    if not candidate_keys:
        return None
    try:
        if not network_base.exists():
            logging.warning("네트워크 베이스 접근 불가: %s", network_base)
            return None
        hits: dict[str, Path] = {}
        for child in network_base.iterdir():
            if not child.is_dir():
                continue
            key = _normalize_key(child.name)
            if key in candidate_keys:
                hits.setdefault(key, child)
        for key in candidate_keys:
            if key in hits:
                return hits[key]
        logging.warning("거래처 폴더 매칭 실패: candidates=%s base=%s", candidates, network_base)
        return None
    except Exception as e:
        logging.warning("거래처 폴더 스캔 실패: %s", e)
        return None


# 인쇄 작업명에 앱이 붙이는 접두사 — PDF24 가 $fileName 으로 받으면 그대로 PDF 명이 됨.
# 예: FlexiSIGN 은 "FlexiSIGN - 간판_베리하운드최종" 으로 보냄 → .fs 는 "간판_베리하운드최종.fs".
# 매칭 전에 이런 접두사를 벗긴 후보도 함께 시도한다(원본 stem 도 그대로 시도하므로 손해 없음).
_PRINT_JOB_PREFIX_RE = re.compile(r"^\s*(?:flexisign|flexsign|adobe illustrator|illustrator)\s*[-–—:]\s*",
                                  re.IGNORECASE)

# FlexiSIGN(또는 Illustrator) 이 .ai/.eps 같은 비-네이티브 파일을 열고 인쇄하면 문서명에 원본
# 확장자가 그대로 남아 인쇄 PDF 가 "원본.ai.pdf" 가 되기도 한다 → stem 이 "원본.ai" 가 되어
# 거래처 폴더의 "원본.fs" 와 정확/유사 매칭 모두 빗나간다. 이런 그래픽 파일 확장자가 stem
# 끝에 붙어 있으면 한 겹 더 벗긴 후보도 함께 시도한다.
_GRAPHICS_EXT_SUFFIX_RE = re.compile(r"\.(?:ai|eps|pdf|psd|svg|cdr|fs|tif|tiff|png|jpg|jpeg)$",
                                     re.IGNORECASE)


def _stem_candidates(pdf_stem: str) -> list[str]:
    """매칭에 쓸 stem 후보들 — 원본 + 인쇄앱 접두사 제거본 + 그래픽 확장자 꼬리 제거본.
    중복/빈값 제거, 순서 보존."""
    out: list[str] = []
    seen: set[str] = set()

    def _add(value: str) -> None:
        value = (value or "").strip()
        if value and value not in seen:
            seen.add(value)
            out.append(value)

    _add(pdf_stem)
    _add(_PRINT_JOB_PREFIX_RE.sub("", pdf_stem).strip())
    # 위에서 모은 각 후보에서 끝에 붙은 그래픽 확장자(.ai, .eps …)를 한 겹씩 더 벗긴 후보.
    for cand in list(out):
        peeled = cand
        m = _GRAPHICS_EXT_SUFFIX_RE.search(peeled)
        while m:
            peeled = peeled[: m.start()].strip()
            _add(peeled)
            m = _GRAPHICS_EXT_SUFFIX_RE.search(peeled)
    return out


# PDF24 자동저장 파일명을 시각값으로 잡아두면(권장 — $fileName 은 FlexiSIGN→PDF24 구간에서
# 한글 도큐먼트명이 깨져 PDF24 가 ErrorCode 123 으로 저장 실패하는 일이 있다) 파일명에
# 원본 정보가 없다. 보통은 사무실 워처가 QR 로 주문을 알아내 원본 .ai stem 으로 리네임해서
# 올리지만(그러면 아래 정확/유사 매칭으로 잡힘), 워처가 원본명을 모르는 작업(작업자가 직접
# 그린 케이스)은 시각값 그대로 올라온다 → 인쇄 시각 근처에 저장된 .fs 로 폴백 매칭한다.
# 허용 형태: 'YYYY-MM-DD HH-MM-SS'(구분자 공백/_/-), 'YYMMDD_HHMMSS', 'YYYYMMDD_HHMMSS' 등.
# 끝에 '(1)' 같은 PDF24 중복 회피 접미사나 '_$id' 고유번호 접미사가 붙어도 인식한다.
_PDF24_TIMESTAMP_RE = re.compile(
    r"^(?:"
    r"(?P<y4a>\d{4})-(?P<mo_a>\d{2})-(?P<d_a>\d{2})[ _\-](?P<h_a>\d{2})-(?P<mi_a>\d{2})-(?P<s_a>\d{2})"
    r"|"
    r"(?P<yb>\d{2}|\d{4})(?P<mo_b>\d{2})(?P<d_b>\d{2})[ _\-]?(?P<h_b>\d{2})(?P<mi_b>\d{2})(?P<s_b>\d{2})"
    r")(?:[ _\-]\w+|\s*\(\d+\))?$"
)


def _parse_pdf24_timestamp(stem: str) -> float | None:
    """stem 이 PDF24 자동 파일명(시각) 형태면 그 시각을 epoch 초로, 아니면 None."""
    m = _PDF24_TIMESTAMP_RE.match((stem or "").strip())
    if not m:
        return None
    try:
        if m.group("y4a") is not None:
            y, mo, d = int(m.group("y4a")), int(m.group("mo_a")), int(m.group("d_a"))
            h, mi, s = int(m.group("h_a")), int(m.group("mi_a")), int(m.group("s_a"))
        else:
            yb = m.group("yb")
            y = int(yb) if len(yb) == 4 else 2000 + int(yb)
            mo, d = int(m.group("mo_b")), int(m.group("d_b"))
            h, mi, s = int(m.group("h_b")), int(m.group("mi_b")), int(m.group("s_b"))
        return datetime(y, mo, d, h, mi, s).timestamp()
    except (ValueError, OverflowError):
        return None


def find_fs_file(customer_folder: Path, pdf_filename: str,
                 fuzzy_threshold: float) -> tuple[Path | None, str]:
    """거래처 폴더 트리에서 .fs 파일 찾기.

    매칭 단계:
      1. 정확 매칭 — `<pdf_stem>.fs` 가 그대로 있는 경우 (대다수). pdf_stem 은 원본 + 인쇄앱
         접두사("FlexiSIGN - " 등) 제거본 둘 다 시도.
      2. 유사 매칭 — 같은 폴더(또는 어디든) 의 .fs 파일들 중 stem 유사도(공백/특수
         문자 정규화 후 SequenceMatcher) 가 임계값 이상 + 후보 단일이면 자동 채택
      3. PDF 명이 PDF24 시각형(저장 전 인쇄) 이면 — 그 시각 ±30분에 저장된 .fs 로 폴백
         (단일이면 채택, 여럿이면 시각이 가장 가까운 것)
      4. 모두 실패 → (None, 사유)

    여러 .fs 가 동일 stem 으로 있으면 가장 최근 수정된 것을 채택(같은 작업의
    버전관리 케이스). 반환: (Path 또는 None, 이유 텍스트)."""
    if not pdf_filename:
        return None, "원본 PDF 파일명이 없습니다."
    pdf_stem = Path(pdf_filename).stem
    if not pdf_stem:
        return None, "PDF 파일명에서 stem 을 추출하지 못했습니다."

    target_keys = [_normalize_key(s) for s in _stem_candidates(pdf_stem)]
    target_keys = [k for k in target_keys if k]
    all_fs: list[Path] = []
    exact_matches: list[Path] = []
    fuzzy_pool: list[tuple[float, Path]] = []
    try:
        for fs in customer_folder.rglob("*.fs"):
            if not fs.is_file():
                continue
            all_fs.append(fs)
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

    # PDF24 시각형 파일명 — 인쇄 시각 근처에 저장된 .fs 로 폴백.
    ts = _parse_pdf24_timestamp(pdf_stem)
    if ts is not None:
        window = 30 * 60  # 인쇄 시각 ±30분
        near = sorted(
            (p for p in all_fs if abs(p.stat().st_mtime - ts) <= window),
            key=lambda p: abs(p.stat().st_mtime - ts),
        )
        if len(near) == 1:
            return near[0], "timestamp-mtime"
        if len(near) >= 2:
            return near[0], f"timestamp-mtime(가장 가까움/{len(near)}건)"
        return None, (
            f"PDF 파일명이 시각값({pdf_stem})입니다 — FlexiSIGN 에서 .fs 를 저장하기 전에 "
            f"인쇄된 것 같습니다. .fs 를 이 거래처 폴더에 저장한 뒤 다시 인쇄하면 자동으로 열립니다. "
            f"거래처 폴더를 열었습니다."
        )

    return None, f"동일 stem 의 .fs 를 찾지 못했습니다: {pdf_stem}.fs (거래처 폴더를 열었습니다)"


def resolve_fs_for_order(meta: dict, customer_folder: Path | None,
                         fuzzy_threshold: float) -> tuple[Path | None, str]:
    """주문 메타로 .fs 파일을 결정. 반환 (Path 또는 None, 매칭종류/이유 텍스트).

    1순위 — originalFsPath: 워처가 인쇄 시점에 거래처 폴더에서 못 박은 .fs 전체 경로.
      그 경로가 실재하면 이름 추측·시각값 폴백·퍼지매칭 없이 그대로 연다 — 한 폴더에
      .fs 가 여럿이어도 지시서마다 자기 파일이 고정돼 엉뚱한 .fs 가 안 열린다.
      리터럴 경로가 죽었으면(현장 PC 의 드라이브 매핑이 다르거나 파일이 폴더 안에서
      옮겨짐) 그 .fs 파일명으로 거래처 폴더를 재탐색한다.
    2순위 — originalPdfFilename: 옛 지시서이거나 워처가 경로를 못 박은 경우. 기존
      find_fs_file(정확/유사/PDF24 시각값 ±30분 폴백) 매칭으로 폴백.
    """
    fs_path = (meta.get("originalFsPath") or "").strip()
    if fs_path:
        direct = Path(fs_path)
        try:
            is_file = direct.is_file()
        except OSError:
            is_file = False
        if is_file:
            return direct, "fspath"
        # 리터럴 경로가 죽음 — .fs 파일명으로 거래처 폴더에서 재탐색.
        if customer_folder is not None:
            relocated, _r = find_fs_file(customer_folder, direct.name, fuzzy_threshold)
            if relocated is not None:
                return relocated, "fspath-relocated"

    pdf_filename = (meta.get("originalPdfFilename") or "").strip()
    if not pdf_filename:
        return None, ("이 지시서엔 .fs 경로도 원본 PDF 파일명도 없어 자동으로 .fs 를 못 찾습니다 "
                      "(워처가 새로 인쇄·'웹에 적용' 하면 다음부턴 자동).")
    if customer_folder is None:
        return None, "거래처 폴더를 찾지 못했습니다."
    return find_fs_file(customer_folder, pdf_filename, fuzzy_threshold)


# ─── FlexiSIGN 실행 ─────────────────────────────────────────────────────
# 정책: 에이전트는 FlexiSIGN 을 새로 띄우지 않는다. 작업자는 보통 FlexiSIGN 을
#       켜둔 채로 작업하므로, 이미 떠 있는 인스턴스에서 .fs 만 열려야 한다(os.startfile
#       = .fs 더블클릭과 동일 → 실행 중이면 그 창에서 열림). FlexiSIGN 이 꺼져 있으면
#       새로 켜지 않고 "먼저 켜세요" 메시지를 돌려준다(켜져 있을 때만 동작 = 더 안정적).
#
# 경로 해석 우선순위: config 의 flexisign_exe(존재할 때) → 레지스트리의 .fs 연결 프로그램
#           → SAi 설치폴더 글롭. 이 경로는 "그 프로세스가 떠 있나" 확인 + 시작 로그용.
# PC마다 설치 경로가 달라도 보통 자동 탐지로 해결되고, 강제 지정이 필요하면
# config.json(공유) 또는 %LOCALAPPDATA%\HDSignFieldViewer\config.local.json(PC별) 에 채운다.

_FS_EXE_CACHE: str | None = None  # "" = 탐지 시도했으나 못 찾음, None = 아직 미시도


def _parse_exe_from_command(cmd: str) -> str | None:
    """레지스트리 shell\\open\\command 값에서 실행파일 경로만 뽑는다.
    예: '"C:\\...\\FlexiSign.exe" "%1"' → 'C:\\...\\FlexiSign.exe'"""
    cmd = (cmd or "").strip()
    if not cmd:
        return None
    if cmd.startswith('"'):
        end = cmd.find('"', 1)
        if end > 1:
            return cmd[1:end]
    m = re.match(r"^(.*?\.exe)\b", cmd, re.IGNORECASE)
    if m:
        return m.group(1)
    return cmd.split(" ")[0]


def _flexisign_from_registry() -> str | None:
    """.fs 더블클릭이 실제로 실행하는 프로그램을 레지스트리에서 찾는다."""
    try:
        import winreg
    except Exception:
        return None
    progid = None
    # 사용자가 명시적으로 고른 연결(UserChoice)이 최우선.
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.fs\UserChoice",
        ) as k:
            progid, _ = winreg.QueryValueEx(k, "ProgId")
    except OSError:
        pass
    if not progid:
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, ".fs") as k:
                progid, _ = winreg.QueryValueEx(k, "")
        except OSError:
            return None
    if not progid:
        return None
    for root in (winreg.HKEY_CLASSES_ROOT, winreg.HKEY_CURRENT_USER):
        sub = rf"{progid}\shell\open\command" if root == winreg.HKEY_CLASSES_ROOT \
            else rf"Software\Classes\{progid}\shell\open\command"
        try:
            with winreg.OpenKey(root, sub) as k:
                cmd, _ = winreg.QueryValueEx(k, "")
            exe = _parse_exe_from_command(cmd)
            if exe and Path(exe).exists():
                return exe
        except OSError:
            continue
    return None


def _flexisign_from_glob() -> str | None:
    """SAi 설치 폴더 아래에서 FlexiSign 실행파일을 찾는다."""
    bases: list[Path] = []
    for env in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
        v = os.environ.get(env)
        if v:
            p = Path(v)
            if p not in bases:
                bases.append(p)
    for base in bases:
        sai = base / "SAi"
        if not sai.is_dir():
            continue
        for name in ("FlexiSign.exe", "FlexiSIGN.exe", "Flexi.exe"):
            for hit in sai.rglob(name):
                return str(hit)
        for hit in sai.rglob("*.exe"):
            if "flexi" in hit.name.lower():
                return str(hit)
    return None


def resolve_flexisign_exe(configured: str | None) -> str | None:
    """FlexiSIGN 실행파일 경로(실행 여부 확인·로그용). 못 찾으면 None — 그 경우
    실행 확인은 기본 후보 프로세스명으로 한다."""
    global _FS_EXE_CACHE
    configured = (configured or "").strip()
    if configured and Path(configured).exists():
        return configured
    if _FS_EXE_CACHE is not None:
        return _FS_EXE_CACHE or None
    found = _flexisign_from_registry() or _flexisign_from_glob()
    _FS_EXE_CACHE = found or ""
    if found:
        logging.info("FlexiSIGN 자동 탐지: %s", found)
    else:
        logging.warning("FlexiSIGN 실행파일을 못 찾음 — 기본 프로세스명(%s)으로 실행 여부 확인",
                        ", ".join(_DEFAULT_FS_PROC_NAMES))
    return found


_DEFAULT_FS_PROC_NAMES = ("flexisign.exe", "flexi.exe", "app.exe")


def _flexisign_process_names(exe_path: str | None, config: dict) -> tuple[str, ...]:
    """FlexiSIGN 실행 여부 확인에 쓸 프로세스 이미지명(소문자) 목록."""
    pn = (config.get("flexisign_process_name") or "").strip().lower()
    if pn:
        return (pn,)
    if exe_path:
        return (Path(exe_path).name.lower(),)
    return _DEFAULT_FS_PROC_NAMES


def flexisign_is_running(exe_path: str | None, config: dict) -> bool:
    """FlexiSIGN 프로세스가 떠 있는지. 확인 자체가 실패하면(드묾) 막지 않고 True."""
    names = _flexisign_process_names(exe_path, config)
    try:
        out = subprocess.run(
            ["tasklist", "/NH", "/FO", "CSV"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.lower()
    except Exception as e:
        logging.warning("tasklist 실행 실패(%s) — FlexiSIGN 실행 확인 생략", e)
        return True
    return any(f'"{n}"' in out for n in names)


def open_in_flexisign(fs_file: Path) -> tuple[bool, str]:
    """.fs 를 윈도우 기본 연결로 연다 — FlexiSIGN 이 이미 떠 있으면 그 창에서 열린다.
    (.fs 더블클릭과 동일. 새 인스턴스를 띄우지 않으려고 exe 를 직접 Popen 하지 않는다.)"""
    try:
        os.startfile(str(fs_file))  # type: ignore[attr-defined]  # Windows 전용
        return True, str(fs_file)
    except Exception as e:
        return False, f".fs 열기 실패({e}) — .fs 가 FlexiSIGN 에 연결돼 있는지 확인하세요."


# 탐색기 창 재활용 — [폴더열기] 클릭마다 새 창이 쌓이지 않게 "직전에 우리가 연 창" 을
# Shell.Application.Navigate 로 새 폴더로 갈아끼운다(닫지 않음).
# 안전 원칙: 사용자가 따로 연 다른 탐색기 창은 절대 닫거나 내비게이트하지 않는다.
#   - 우리 창 식별: 새 창을 열 때 Shell.Windows() 의 HWND 를 기록하고, 그 HWND 의
#     현재 경로가 우리가 마지막에 띄운 경로와 같을 때만 "여전히 우리 창" 으로 본다.
#     (사용자가 우리 창을 다른 폴더로 옮겼다면 그 창은 그대로 두고 새 창을 연다 → 누적
#     이 가끔 1번 더 생길 수 있어도 안전 우선.)
# PowerShell + Shell.Application 으로 처리 — Python 표준 라이브러리로는 COM 호출이
# 까다로워서 이 한 군데만 PS 에 위임한다. PS 시동(~0.5-1s) 은 백그라운드 스레드에서
# 흡수해 HTTP 응답은 지연시키지 않는다.
_OPENED_EXPLORER_HWND: int | None = None
_OPENED_EXPLORER_TARGET: str | None = None  # 우리가 마지막에 띄운(또는 내비게이트한) 폴더 경로.
_OPENED_EXPLORER_LOCK = threading.Lock()
_SW_RESTORE = 9


# Shell.Application 으로 "우리 창" 만 안전하게 재활용하는 PowerShell 스크립트.
# 입력(환경변수): HD_TARGET, HD_PREV_HWND, HD_LAST_TARGET
# 출력(stdout 마지막 비어있지 않은 줄): 결과 HWND 정수(>0 성공, 0 실패).
#
# 동작:
#   1) 추적 HWND 가 살아있고 + 그 창 현재 경로 == HD_LAST_TARGET 면 → Navigate(HD_TARGET).
#      (= 사용자가 우리 창을 안 건드린 경우만 재활용)
#   2) 아니면 새 explorer.exe HD_TARGET 을 띄우고, Shell.Windows() 차분으로 새 창을 찾되
#      Document.Folder.Self.Path 가 HD_TARGET 과 일치하는 창만 채택(혼동 방지).
#   3) 어느 경로로든 사용자가 따로 연 창은 손대지 않음(목록만 읽지 수정 0).
_NAVIGATE_OR_OPEN_PS = r"""
$ErrorActionPreference = 'SilentlyContinue'
function Norm([string]$p) {
    if (-not $p) { return '' }
    return $p.TrimEnd('\').ToLowerInvariant()
}
$target = $env:HD_TARGET
$prev = 0
[void][int]::TryParse(($env:HD_PREV_HWND), [ref]$prev)
$lastTargetNorm = Norm $env:HD_LAST_TARGET
$targetNorm = Norm $target
$shell = New-Object -ComObject Shell.Application
$result = 0
if ($prev -gt 0 -and $lastTargetNorm -ne '') {
    foreach ($w in $shell.Windows()) {
        try {
            if ([int]$w.HWND -ne $prev) { continue }
            # 우리가 추적한 그 HWND. 현재 경로가 마지막으로 우리가 띄운 경로와 같을 때만
            # 재활용 — 사용자가 다른 폴더로 옮겼다면 그 창은 그대로 두고 새 창을 연다.
            $cur = $null
            try { $cur = $w.Document.Folder.Self.Path } catch { }
            if ((Norm $cur) -eq $lastTargetNorm) {
                $w.Navigate($target)
                $result = $prev
            }
            break
        } catch { }
    }
}
if ($result -eq 0) {
    # 새 창 열기. Start-Process 전후 Shell.Windows HWND 차분으로 우리 새 창 식별.
    $before = @{}
    foreach ($w in $shell.Windows()) {
        try { $before[[int]$w.HWND] = $true } catch { }
    }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target + '"') | Out-Null
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        foreach ($w in $shell.Windows()) {
            try {
                $h = [int]$w.HWND
                if ($before.ContainsKey($h)) { continue }
                $cur = $null
                try { $cur = $w.Document.Folder.Self.Path } catch { }
                # 새 창 중에서도 우리 target 을 띄운 창만 채택 — 그 사이 사용자가
                # 자기 폴더창을 따로 열었어도 그건 손대지 않는다.
                if ((Norm $cur) -eq $targetNorm) {
                    $result = $h
                    break
                }
            } catch { }
        }
        if ($result -ne 0) { break }
    }
}
Write-Output $result
"""


def _bring_to_front(hwnd: int) -> None:
    """창을 앞으로(최소화돼 있으면 복원). SetForegroundWindow 는 포그라운드 권한이 없으면
    조용히 실패할 수 있는데(클릭 직후엔 보통 먹힘) 그래도 ShowWindow 로 최소화 해제는 되니 무해."""
    import ctypes
    try:
        user32 = ctypes.windll.user32
        user32.ShowWindow(hwnd, _SW_RESTORE)
        user32.SetForegroundWindow(hwnd)
    except Exception as e:
        logging.debug("창 활성화 실패 (HWND=%s): %s", hwnd, e)


def _navigate_or_open(target: str) -> None:
    """우리가 추적 중인 창이 (살아있고 + 사용자가 안 건드렸으면) Navigate, 아니면 새 창.
    어느 경로로도 사용자가 따로 연 다른 탐색기 창은 닫거나 바꾸지 않는다. HTTP 응답을 막지
    않도록 백그라운드 스레드에서 호출된다.
    PowerShell 호출이 실패할 때만 os.startfile 로 폴백 — 그 경우 누적 방지는 못 해도(이번
    한 번 새 창이 추가될 수 있음) 폴더 자체는 열린다."""
    global _OPENED_EXPLORER_HWND, _OPENED_EXPLORER_TARGET
    # PS 호출은 직렬화 — 빠른 연타 클릭이 동시에 PS 두 개 띄우지 않게.
    with _OPENED_EXPLORER_LOCK:
        prev_hwnd = _OPENED_EXPLORER_HWND or 0
        prev_target = _OPENED_EXPLORER_TARGET or ""
        env = dict(os.environ)
        env["HD_TARGET"] = target
        env["HD_PREV_HWND"] = str(prev_hwnd)
        env["HD_LAST_TARGET"] = prev_target
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-Command", _NAVIGATE_OR_OPEN_PS],
                capture_output=True, text=True, timeout=30, env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:
            logging.warning("PowerShell 탐색기 처리 실패 — os.startfile 폴백: %s", e)
            try:
                os.startfile(target)  # type: ignore[attr-defined]
            except Exception as e2:
                logging.warning("폴더 열기 폴백 실패: %s", e2)
            return
        new_hwnd: int | None = None
        for line in reversed((r.stdout or "").splitlines()):
            s = line.strip()
            if s.isdigit() and int(s) > 0:
                new_hwnd = int(s)
                break
        if new_hwnd is None:
            logging.warning(
                "탐색기 창 식별 실패 (rc=%s stdout=%r stderr=%r) — os.startfile 폴백",
                r.returncode, (r.stdout or "")[-200:], (r.stderr or "")[-200:],
            )
            try:
                os.startfile(target)  # type: ignore[attr-defined]
            except Exception as e:
                logging.warning("폴더 열기 폴백 실패: %s", e)
            return
        _OPENED_EXPLORER_HWND = new_hwnd
        _OPENED_EXPLORER_TARGET = target
    _bring_to_front(new_hwnd)


def open_folder_in_explorer(folder: Path) -> None:
    """거래처 폴더(또는 .fs 상위 폴더)를 탐색기로 연다. 이전에 [폴더열기]로 열어 둔 창이
    아직 살아있고 사용자가 그 폴더 그대로 두고 있다면 그 창을 새 폴더로 갈아끼우고
    (Navigate), 아니면 새 창을 연다 — 화면엔 우리 창이 최대 1개만 남는다.
    사용자가 따로 연/직접 다른 폴더로 옮긴 탐색기 창은 절대 닫거나 바꾸지 않는다.
    HTTP 응답이 PowerShell 시동(~0.5-1s) 만큼 늘어지지 않도록 백그라운드 스레드 처리."""
    threading.Thread(
        target=_navigate_or_open,
        args=(str(folder),),
        daemon=True,
    ).start()


# ─── 백엔드 API ─────────────────────────────────────────────────────────

def fetch_worksheet(api_base: str, order_number: str) -> dict | None:
    # /locator — 거래처 폴더명(networkFolderName)·원본 PDF 파일명(originalPdfFilename)·워처가
    # 못 박은 .fs 전체 경로(originalFsPath) 를 돌려주는 가벼운 엔드포인트. /{orderNumber} (detail)
    # 와 달리 휴지통/아카이브 상태를 따지지 않으므로 "옛 지시서 찾기"로 찾아낸, 이미 파일이
    # 정리된 옛 건의 .fs 도 거래처 폴더에서 열 수 있다.
    url = f"{api_base.rstrip('/')}/api/public/worksheets/{urllib.parse.quote(order_number, safe='')}/locator"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10, context=SSL_CONTEXT) as resp:
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
        # 이지폼 자동기입 feature-detect — 에이전트가 떠 있고 이 PC 가 Win32 가능할 때만 true.
        if parsed.path == "/easyform/probe":
            origin = self._origin_allowed()
            self._send_json(200, {"ok": True, "easyform": EASYFORM_AVAILABLE,
                                  "hotkey": EF_HOTKEY_LABEL}, origin)
            return
        # /open, /open-folder 는 비-단순(custom header) POST 만 허용 → CSRF 노출 최소화.
        # 그래도 GET 으로 들어오는 단순 fetch 케이스를 친절히 안내.
        if parsed.path in ("/open", "/open-folder"):
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
        if parsed.path not in ("/open", "/open-folder", "/easyform/fill"):
            self.send_response(404)
            self._send_cors(origin)
            self.end_headers()
            return

        # custom header 검사 — preflight 우회 시도 차단(X-HDSign-Field 가 없으면 거부).
        if self.headers.get("X-HDSign-Field") != "1":
            self._send_json(400, {"message": "X-HDSign-Field 헤더 필요"}, origin)
            return

        # 이지폼 자동기입 — grid 를 받아 스테이징(arm)만. 실제 실행은 사용자가 이지폼 창에서 핫키.
        if parsed.path == "/easyform/fill":
            self._handle_easyform_fill(origin)
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

        if parsed.path == "/open-folder":
            result = self.process_open_folder(order_number)
        else:
            result = self.process_open(order_number)
        self._send_json(200, result, origin)  # 200 + opened/opened=false 로 통일(웹은 메시지로 분기)

    def process_open(self, order_number: str) -> dict:
        config = self.config
        api_base = (config.get("api_base") or "").strip()
        network_base_str = (config.get("network_customer_base") or "").strip()
        fuzzy_threshold = float(config.get("fuzzy_threshold") or 0.85)

        if not api_base:
            return {"opened": False, "message": "config.json 의 api_base 가 설정되지 않았습니다."}
        if not network_base_str:
            return {"opened": False, "message": "config.json 의 network_customer_base 가 설정되지 않았습니다."}

        meta = fetch_worksheet(api_base, order_number)
        if not meta:
            return {"opened": False, "message": f"백엔드에서 [{order_number}] 정보를 가져오지 못했습니다."}

        company = (meta.get("companyName") or "").strip()
        network_folder_name = (meta.get("networkFolderName") or "").strip()
        network_base = Path(network_base_str)
        # 거래처 폴더 — 폴백 매칭 + 결과 메시지용. 못 찾아도(None) originalFsPath(절대경로) 직행은 가능.
        customer_folder = None
        if network_folder_name or company:
            customer_folder = find_customer_folder(network_base, network_folder_name, company)

        # .fs 해석 — originalFsPath(워처가 인쇄 시점에 못 박은 전체 경로) 우선, 없으면
        # originalPdfFilename 기반 매칭(정확/유사/PDF24 시각값 ±30분 폴백). originalFsPath 는
        # 절대경로라 거래처 폴더 탐색이 실패해도 그 .fs 를 곧장 연다.
        fs_file, reason = resolve_fs_for_order(meta, customer_folder, fuzzy_threshold)
        if fs_file is None:
            # 거래처 폴더라도 찾았으면 그 폴더를 열어 사용자가 직접 .fs 를 고르게 한다.
            if customer_folder is None:
                return {
                    "opened": False,
                    "message": f"{reason} 거래처 폴더도 찾지 못했습니다 "
                               f"({network_folder_name or company or '거래처 정보 없음'}).",
                }
            open_folder_in_explorer(customer_folder)
            return {
                "opened": False,
                "message": f"{reason} 거래처 폴더를 열었습니다.",
                "customerFolder": str(customer_folder),
            }

        flexisign_exe = resolve_flexisign_exe(config.get("flexisign_exe"))
        if not flexisign_is_running(flexisign_exe, config):
            return {
                "opened": False,
                "needsFlexiSign": True,
                "message": "FlexiSIGN 이 실행돼 있지 않습니다. FlexiSIGN 을 먼저 켠 뒤 다시 [FS에서 열기] 를 누르세요.",
            }
        ok, info = open_in_flexisign(fs_file)
        if not ok:
            return {"opened": False, "message": info}
        logging.info("FS 실행 [%s] → %s (%s)", order_number, fs_file.name, reason)
        return {
            "opened": True,
            "matchedFile": fs_file.name,
            "matchKind": reason,
            "customerFolder": str(customer_folder) if customer_folder is not None else None,
        }

    def process_open_folder(self, order_number: str) -> dict:
        """[폴더열기] — 그 지시서의 .fs(찾으면 그 파일이 든 폴더), 못 찾으면 거래처 폴더를
        탐색기로 연다. FlexiSIGN 은 건드리지 않는다."""
        config = self.config
        api_base = (config.get("api_base") or "").strip()
        network_base_str = (config.get("network_customer_base") or "").strip()
        fuzzy_threshold = float(config.get("fuzzy_threshold") or 0.85)

        if not api_base:
            return {"opened": False, "message": "config.json 의 api_base 가 설정되지 않았습니다."}
        if not network_base_str:
            return {"opened": False, "message": "config.json 의 network_customer_base 가 설정되지 않았습니다."}

        meta = fetch_worksheet(api_base, order_number)
        if not meta:
            return {"opened": False, "message": f"백엔드에서 [{order_number}] 정보를 가져오지 못했습니다."}

        company = (meta.get("companyName") or "").strip()
        network_folder_name = (meta.get("networkFolderName") or "").strip()
        network_base = Path(network_base_str)
        # 거래처 폴더 — 못 찾아도(None) originalFsPath(절대경로) 로 .fs 가 든 폴더는 열 수 있다.
        customer_folder = None
        if network_folder_name or company:
            customer_folder = find_customer_folder(network_base, network_folder_name, company)

        # originalFsPath(워처가 못 박은 .fs 전체 경로) 우선, 없으면 originalPdfFilename 매칭.
        fs_file, _reason = resolve_fs_for_order(meta, customer_folder, fuzzy_threshold)
        if fs_file is None and customer_folder is None:
            return {
                "opened": False,
                "message": f"거래처 폴더를 찾지 못했습니다: "
                           f"{network_folder_name or company or '거래처 정보 없음'}",
            }
        target = fs_file.parent if fs_file is not None else customer_folder
        matched_file = fs_file.name if fs_file is not None else None
        open_folder_in_explorer(target)
        logging.info("폴더 열기 [%s] → %s%s", order_number, target,
                     f" (.fs: {matched_file})" if matched_file else "")
        return {
            "opened": True,
            "folder": str(target),
            "matchedFile": matched_file,
            "customerFolder": str(customer_folder) if customer_folder is not None else None,
            "message": (f"{matched_file} 가 든 폴더를 열었습니다." if matched_file
                        else "거래처 폴더를 열었습니다."),
        }

    # 이지폼 자동기입 셀 키 — 정확히 이 7개만 받는다(월일=자동·비고=미사용). 그 밖의 키(특히
    # save/enter/commit 같은 '확정 지시'로 보이는 것)는 무시·거부 → IRON LAW 심층방어.
    _EF_ROW_KEYS = ("item_code", "item", "spec", "qty", "unit_price", "supply", "tax")

    def _handle_easyform_fill(self, origin: str | None) -> None:
        if not EASYFORM_AVAILABLE:
            self._send_json(200, {"staged": False,
                                  "message": "이 PC 에서는 이지폼 자동기입을 쓸 수 없습니다."}, origin)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send_json(400, {"staged": False, "message": "본문 파싱 실패"}, origin)
            return
        rows_in = body.get("rows") if isinstance(body, dict) else None
        if not isinstance(rows_in, list) or not rows_in:
            self._send_json(400, {"staged": False, "message": "rows 가 비어 있습니다."}, origin)
            return
        # 허용된 7개 셀 키만 추려 sanitized 행 구성(나머지는 무시). 값은 모두 문자열화.
        rows: list[dict] = []
        for r in rows_in:
            if not isinstance(r, dict):
                continue
            rows.append({k: ("" if r.get(k) is None else str(r.get(k)))
                         for k in self._EF_ROW_KEYS})
        if not rows:
            self._send_json(400, {"staged": False, "message": "유효한 행이 없습니다."}, origin)
            return
        cap = len(EF_CELLS)
        if len(rows) > cap:
            self._send_json(200, {"staged": False,
                                  "message": f"행이 {len(rows)}개로 한도({cap}행)를 넘어 보낼 수 없습니다."},
                            origin)
            return
        ef_stage_job(rows)
        logging.info("이지폼 자동기입 스테이징 — %d행, %s 대기", len(rows), EF_HOTKEY_LABEL)
        self._send_json(200, {
            "staged": True,
            "count": len(rows),
            "hotkey": EF_HOTKEY_LABEL,
            "message": f"이지폼 '매출 거래명세서' 새로작성 → 거래처 선택 후, 그 창에서 {EF_HOTKEY_LABEL} 키를 누르면 {len(rows)}행이 자동 기입됩니다.",
        }, origin)


# ─── 이지폼 자동기입 (slice-14) ────────────────────────────────────────────
#
# 자동견적 명세서(grid)를 이지폼 '매출 거래명세서' 새로작성 화면에 셀 단위로 자동 기입한다.
# IRON LAW: Enter/저장(F5)/전자전송(F11) 등 **확정 키는 절대 보내지 않는다**. 매크로가 쓰는
# 입력은 ① 셀 클릭(SetCursorPos+좌클릭) ② 흰 박스에 행수기준 '2' 한 글자 ③ Ctrl+V(붙여넣기)
# 뿐이다. 최종 저장/전자발행은 사람이 직접 확인 후 누른다.
#
# 좌표계: easyform_pick.py / easyform_layout.json 과 동일한 **논리 픽셀**. 클릭 직전 DPI_SCALE
# 을 곱해 물리 좌표로 변환한다(=batch.py 규약). 좌표는 이지폼 창 위치에 의존하므로, 캡처할 때와
# 같은 위치/크기로 창을 둬야 한다.

EASYFORM_AVAILABLE = False
try:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        _user32 = ctypes.WinDLL("user32", use_last_error=True)
        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                _user32.SetProcessDPIAware()
            except Exception:
                pass

        def _ef_scale() -> float:
            try:
                gdi32 = ctypes.windll.gdi32
                hdc = _user32.GetDC(0)
                dpi = gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
                _user32.ReleaseDC(0, hdc)
                return dpi / 96.0
            except Exception:
                return 1.0

        EF_DPI_SCALE = _ef_scale()

        _user32.OpenClipboard.argtypes = [wintypes.HWND]; _user32.OpenClipboard.restype = wintypes.BOOL
        _user32.EmptyClipboard.restype = wintypes.BOOL
        _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]; _user32.SetClipboardData.restype = wintypes.HANDLE
        _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]; _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
        _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]; _kernel32.GlobalLock.restype = wintypes.LPVOID
        _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]; _kernel32.GlobalUnlock.restype = wintypes.BOOL
        _user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]; _user32.SetCursorPos.restype = wintypes.BOOL
        _user32.GetForegroundWindow.restype = wintypes.HWND
        _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; _user32.GetWindowTextW.restype = ctypes.c_int
        _user32.GetAsyncKeyState.argtypes = [ctypes.c_int]; _user32.GetAsyncKeyState.restype = ctypes.c_short
        _user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
        _user32.MessageBoxW.restype = ctypes.c_int

        _CF_UNICODETEXT = 13
        _GMEM_MOVEABLE = 0x0002
        _INPUT_MOUSE = 0
        _INPUT_KEYBOARD = 1
        _KEYEVENTF_KEYUP = 0x0002
        _MOUSEEVENTF_LEFTDOWN = 0x0002
        _MOUSEEVENTF_LEFTUP = 0x0004

        class _EF_MI(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class _EF_KI(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class _EF_U(ctypes.Union):
            _fields_ = [("mi", _EF_MI), ("ki", _EF_KI), ("pad", ctypes.c_byte * 32)]

        class _EF_IN(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("u", _EF_U)]

        def _ef_send(inputs):
            arr = (_EF_IN * len(inputs))(*inputs)
            _user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_EF_IN))

        def _ef_open_clipboard(retries: int = 15) -> bool:
            for _ in range(retries):
                if _user32.OpenClipboard(None):
                    return True
                time.sleep(0.02)
            return False

        def ef_set_clipboard(text: str) -> None:
            if not _ef_open_clipboard():
                return
            try:
                _user32.EmptyClipboard()
                data = (text + "\0").encode("utf-16-le")
                h = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
                ptr = _kernel32.GlobalLock(h)
                ctypes.memmove(ptr, data, len(data))
                _kernel32.GlobalUnlock(h)
                _user32.SetClipboardData(_CF_UNICODETEXT, h)
            finally:
                _user32.CloseClipboard()

        def ef_click(x: int, y: int) -> None:
            _user32.SetCursorPos(int(x * EF_DPI_SCALE), int(y * EF_DPI_SCALE))
            time.sleep(0.03)
            d = _EF_MI(0, 0, 0, _MOUSEEVENTF_LEFTDOWN, 0, None)
            u = _EF_MI(0, 0, 0, _MOUSEEVENTF_LEFTUP, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=m)) for m in (d, u)])

        def ef_double_click(x: int, y: int) -> None:
            ef_click(x, y)
            time.sleep(0.05)
            ef_click(x, y)

        def ef_key(vk: int, mods=None) -> None:
            mods = mods or []
            seq = []
            for m in mods:
                seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(m, 0, 0, 0, None))))
            seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(vk, 0, 0, 0, None))))
            seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(vk, 0, _KEYEVENTF_KEYUP, 0, None))))
            for m in reversed(mods):
                seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(m, 0, _KEYEVENTF_KEYUP, 0, None))))
            _ef_send(seq)

        def ef_paste() -> None:
            ef_key(0x56, [0x11])  # Ctrl(0x11) + V(0x56) — IRON LAW 허용 키시퀀스

        def ef_foreground_title() -> str:
            h = _user32.GetForegroundWindow()
            buf = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(h, buf, 256)
            return buf.value

        def ef_messagebox(text: str, title: str = "HD사인 이지폼") -> None:
            # MB_OK(0) | MB_TOPMOST(0x40000) | MB_SETFOREGROUND(0x10000)
            try:
                _user32.MessageBoxW(None, text, title, 0x50000)
            except Exception:
                pass

        EASYFORM_AVAILABLE = True
except Exception as _ef_e:  # noqa: BLE001 — Win32 초기화 실패 시 기능만 비활성
    logging.warning("이지폼 자동기입 비활성(Win32 초기화 실패): %s", _ef_e)
    EASYFORM_AVAILABLE = False


# ── 셀 좌표 (논리 픽셀) — easyform_layout.json 의 90셀 + pick 으로 찍은 컨트롤 2개 ──
# 열 순서: month_day, item_code, item, spec, qty, unit_price, supply, tax, remark
EF_COLS = ["month_day", "item_code", "item", "spec", "qty", "unit_price", "supply", "tax", "remark"]
EF_CELLS = [
    [(27, 297), (82, 300), (200, 301), (319, 300), (374, 302), (429, 302), (500, 302), (572, 303), (643, 301)],
    [(29, 319), (83, 321), (202, 322), (319, 321), (371, 321), (428, 322), (495, 321), (566, 321), (637, 324)],
    [(27, 341), (85, 342), (208, 342), (324, 342), (375, 342), (430, 341), (493, 341), (565, 342), (644, 345)],
    [(29, 360), (84, 364), (207, 364), (321, 365), (373, 361), (427, 361), (500, 363), (577, 363), (646, 363)],
    [(27, 381), (82, 381), (197, 383), (323, 383), (372, 383), (426, 382), (494, 382), (568, 384), (643, 384)],
    [(28, 404), (88, 405), (202, 407), (326, 405), (372, 405), (430, 401), (493, 402), (567, 404), (643, 404)],
    [(26, 421), (82, 424), (211, 422), (321, 422), (375, 424), (430, 426), (494, 425), (568, 424), (638, 424)],
    [(30, 445), (87, 445), (212, 444), (326, 445), (373, 445), (428, 444), (493, 446), (566, 446), (648, 446)],
    [(28, 467), (88, 467), (207, 466), (319, 466), (378, 466), (427, 466), (501, 468), (571, 467), (644, 469)],
    [(29, 486), (86, 486), (203, 487), (323, 488), (372, 490), (431, 491), (490, 487), (567, 487), (643, 487)],
]
EF_WHITEBOX = (756, 417)   # "현재 □ 줄 선택됨" 흰 박스 — 더블클릭 후 '2' 입력
EF_INSERT_BTN = (745, 456)  # "삽입" 버튼 — 행 수만큼 클릭

# 채울 7칸: (grid 키, EF_COLS 인덱스, 숫자 여부). 월일·비고는 건드리지 않는다(월일=자동).
EF_FILL_SEQ = [
    ("item_code", 1, False), ("item", 2, False), ("spec", 3, False),
    ("qty", 4, True), ("unit_price", 5, True), ("supply", 6, True), ("tax", 7, True),
]


def _ef_num(s: str) -> str:
    """숫자 셀 값 — 콤마/공백 제거(이지폼 숫자칸이 '15,000' 붙여넣기를 거부할 수 있어 '15000' 으로)."""
    return (s or "").replace(",", "").replace(" ", "").strip()


def run_easyform_fill(rows: list[dict]) -> tuple[bool, str]:
    """이지폼 새로작성 그리드에 rows 를 셀 단위로 기입. (성공여부, 메시지)."""
    if not EASYFORM_AVAILABLE:
        return False, "이 PC 에서는 이지폼 자동기입을 쓸 수 없습니다(Win32 미초기화)."
    n = len(rows)
    if n == 0:
        return False, "기입할 행이 없습니다."
    cap = len(EF_CELLS)  # 10
    if n > cap:
        return False, (f"행이 {n}개로 자동기입 한도({cap}행)를 넘습니다. "
                       f"먼저 {cap}행 이하로 나눠 작성해 주세요. (현재 버전 미지원)")

    # 0) 첫 행 품목칸 클릭 — 그리드 활성화 + 첫 행 월일 자동기입 트리거
    ef_click(*EF_CELLS[0][EF_COLS.index("item")])
    time.sleep(0.15)

    # 1) 흰 박스 더블클릭 → '2' 입력(삽입 위치=둘째 줄: 월일행이 맨 위 유지)
    ef_double_click(*EF_WHITEBOX)
    time.sleep(0.1)
    ef_key(0x32)  # '2'
    time.sleep(0.1)

    # 2) 삽입 N번 — 기존 1행 + N = N+1행(마지막 1행은 여유분)
    for _ in range(n):
        ef_click(*EF_INSERT_BTN)
        time.sleep(0.12)

    time.sleep(0.2)

    # 3) 행마다 7칸 클릭+붙여넣기 (월일은 행 진입 시 자동, 비고는 건드리지 않음)
    for r in range(n):
        row = rows[r]
        for key_name, col_idx, is_num in EF_FILL_SEQ:
            val = str(row.get(key_name, "") or "")
            if is_num:
                val = _ef_num(val)
            if val == "":
                continue  # 빈 값은 칸을 건드리지 않음
            x, y = EF_CELLS[r][col_idx]
            ef_click(x, y)
            time.sleep(0.08)            # 셀 활성화 대기(batch.py 검증 타이밍)
            ef_set_clipboard(val)
            time.sleep(0.02)
            ef_paste()
            time.sleep(0.05)

    # 4) 마지막 셀 확정 — 여유분(다음) 행 품목칸 클릭(저장/Enter 안 함). 한도면 마지막 행 재클릭.
    commit_r = min(n, cap - 1)
    ef_click(*EF_CELLS[commit_r][EF_COLS.index("item")])
    return True, f"{n}개 행을 기입했습니다. 내용 확인 후 직접 저장(F5)하세요."


# ── 스테이징 + 핫키 트리거 ──────────────────────────────────────────────────
# 웹 '이지폼 입력' 버튼이 grid 를 POST 하면 여기 담아두고(arm), 사용자가 이지폼 창에서 핫키를
# 누르면 그때 실행한다. 이렇게 분리하는 이유: 클릭이 정확한 창에 떨어지려면 실행 순간 이지폼이
# 최상위여야 하는데, 웹 버튼을 누른 직후엔 브라우저가 최상위이기 때문.
_EF_LOCK = threading.Lock()
_EF_JOB: dict | None = None          # {"rows": [...], "armed_at": ts}
_EF_RUNNING = False
EF_JOB_TTL = 1800                    # 30분 지나면 자동 만료(새로작성·거래처 선택 여유)
EF_HOTKEY_VK = 0x75                  # F6 (이지폼 단축키 F2/F5/F8/F9/F11/F12/Esc 와 충돌 없음)
EF_HOTKEY_LABEL = "F6"


def ef_stage_job(rows: list[dict]) -> None:
    global _EF_JOB
    with _EF_LOCK:
        _EF_JOB = {"rows": rows, "armed_at": time.time()}


def _ef_take_job() -> dict | None:
    global _EF_JOB
    with _EF_LOCK:
        job = _EF_JOB
        if job is None:
            return None
        if time.time() - job["armed_at"] > EF_JOB_TTL:
            _EF_JOB = None
            return None
        _EF_JOB = None
        return job


def _ef_is_easyform_foreground() -> bool:
    title = ef_foreground_title()
    return ("이지폼" in title) or ("거래명세서" in title)


def _ef_hotkey_watcher() -> None:
    """핫키 폴링 — 눌리는 순간(엣지) + 스테이징된 작업 + 이지폼이 최상위일 때만 실행."""
    global _EF_RUNNING
    was_down = False
    while True:
        time.sleep(0.03)
        down = bool(_user32.GetAsyncKeyState(EF_HOTKEY_VK) & 0x8000)
        edge = down and not was_down
        was_down = down
        if not edge or _EF_RUNNING:
            continue
        with _EF_LOCK:
            has_job = _EF_JOB is not None
        if not has_job:
            continue  # 무장 안 된 상태의 핫키는 무시(오발사 방지)
        if not _ef_is_easyform_foreground():
            ef_messagebox(
                "이지폼 '매출 거래명세서' 새로작성 창을 맨 앞에 두고 다시 " + EF_HOTKEY_LABEL + " 를 누르세요.",
                "이지폼 자동기입",
            )
            continue
        job = _ef_take_job()
        if job is None:
            continue
        _EF_RUNNING = True
        try:
            ok, msg = run_easyform_fill(job["rows"])
        except Exception as e:  # noqa: BLE001
            ok, msg = False, f"자동기입 중 오류: {e}"
            logging.exception("이지폼 자동기입 오류")
        finally:
            _EF_RUNNING = False
        ef_messagebox(
            ("작성이 완료되었습니다.\n\n" + msg) if ok else ("기입 실패\n\n" + msg),
            "이지폼 자동기입",
        )
        logging.info("이지폼 자동기입 %s — %s", "성공" if ok else "실패", msg)


def start_easyform_watcher() -> None:
    if not EASYFORM_AVAILABLE:
        logging.info("이지폼 자동기입: 비활성(이 PC 는 Win32 미초기화 — 기능 숨김)")
        return
    threading.Thread(target=_ef_hotkey_watcher, daemon=True).start()
    logging.info("이지폼 자동기입: 대기(DPI %.2fx). 웹에서 보낸 뒤 이지폼 창에서 %s 로 실행.",
                 EF_DPI_SCALE, EF_HOTKEY_LABEL)


# ─── 메인 ────────────────────────────────────────────────────────────────

def serve_forever(config: dict) -> None:
    port = int(config.get("port") or 17345)
    FieldAgentHandler.config = config
    # 127.0.0.1 바인딩 — 동일 PC 의 브라우저만 접근. LAN 의 다른 PC 가 호출 불가.
    server = ThreadingHTTPServer(("127.0.0.1", port), FieldAgentHandler)
    logging.info("HD사인 작업뷰어 에이전트 — http://127.0.0.1:%d 에서 대기 중", port)
    logging.info("API 베이스: %s", config.get("api_base"))
    logging.info("네트워크 베이스: %s", config.get("network_customer_base"))
    _fs = resolve_flexisign_exe(config.get("flexisign_exe"))
    logging.info("FlexiSIGN: %s (실행 중일 때만 .fs 를 그 창에서 엶 — 새로 띄우지 않음)",
                 _fs or "(경로 미발견)")
    logging.info("허용 origin: %s", ", ".join(config.get("allowed_origins") or []))
    start_easyform_watcher()
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
