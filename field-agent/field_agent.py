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
      3. 모두 실패 → (None, 사유). PDF 명이 PDF24 시각형이면 안내 메시지를 덧붙인다.

    ※ 예전엔 시각형 파일명일 때 인쇄 시각 ±30분의 .fs 를 자동으로 열었으나, 우연히 다른
      지시서를 여는 오작동이 잦아 제거했다(이름이 아니라 시각으로 맞히는 추측이라 신뢰 불가).
      새 인쇄는 워처가 박는 UID(ADS, resolve_fs_for_order 1·2순위)로 정확 매칭되므로 이 이름
      매칭은 UID 가 없는 옛 지시서 전용 폴백이다.

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

    # PDF24 시각형 파일명 — 이름에 원본 정보가 없어 .fs 를 이름으로 특정할 수 없다. 예전엔
    # 인쇄 시각 ±30분의 .fs 를 자동으로 열었으나 우연히 다른 지시서를 여는 오작동이 잦아
    # 제거했다(시각으로 맞히는 추측은 신뢰 불가). 자동으로 열지 않고 안내만 한다 — 새로 인쇄
    # (웹반영) 하면 워처가 UID(ADS)를 박아 다음부턴 이름·시각과 무관하게 정확히 열린다.
    if _parse_pdf24_timestamp(pdf_stem) is not None:
        return None, (
            f"PDF 파일명이 시각값({pdf_stem})이라 .fs 를 이름으로 특정할 수 없습니다 — "
            f"FlexiSIGN 에서 .fs 를 저장한 뒤 다시 인쇄(웹반영)하면 자동으로 정확히 열립니다. "
            f"거래처 폴더를 열었습니다."
        )

    return None, f"동일 stem 의 .fs 를 찾지 못했습니다: {pdf_stem}.fs (거래처 폴더를 열었습니다)"


# 워처가 .fs 에 박아 둔 NTFS ADS 이름 — 인쇄마다 발급된 UID 가 여기 들어 있다.
# (워처의 _FS_UID_STREAM 과 반드시 동일해야 한다.) ADS 는 같은 NTFS 볼륨/SMB 공유 안에서
# 파일을 rename·이동해도 따라다니므로, 작업자가 .fs 이름을 바꿔도 이 UID 로 정확히 매칭된다.
_FS_UID_STREAM = "hdsign.fsuid"


def _read_ads_fsuid(fs_file: Path) -> str | None:
    """fs_file 의 NTFS ADS(hdsign.fsuid)에 적힌 UID 를 읽어 반환. 스트림이 없거나(스탬프 안 됨)
    읽기 실패면 None. 혹시 모를 BOM 까지 흡수하도록 utf-8-sig 로 읽는다."""
    try:
        with open(f"{fs_file}:{_FS_UID_STREAM}", "r", encoding="utf-8-sig") as f:
            v = f.read().strip()
        return v or None
    except (OSError, ValueError):
        return None


def resolve_fs_for_order(meta: dict, customer_folder: Path | None,
                         fuzzy_threshold: float) -> tuple[Path | None, str]:
    """주문 메타로 .fs 파일을 결정. 반환 (Path 또는 None, 매칭종류/이유 텍스트).

    1순위 — originalFsUid(.fs 에 박힌 ADS UID): 워처가 인쇄 시점에 그 .fs 에 발급해 박은 전역
      고유 ID. originalFsPath(절대경로)가 살아 있으면 그 파일의 ADS 가 UID 와 같은지 확인까지
      해서(다른 작업으로 덮어쓰여 같은 경로에 엉뚱한 .fs 가 놓인 경우 차단) 곧장 연다. 경로가
      죽었거나(이름변경/이동) ADS 가 어긋나면 거래처 폴더를 UID 로 스캔해 정확히 회수한다 —
      작업자가 파일명을 바꿔도 ADS 가 따라다녀 매칭된다.
    2순위 — originalFsPath 만 있고 UID 가 없는 옛 지시서: 경로 실재 시 그대로, 죽었으면 그
      .fs 파일명으로 재탐색.
    3순위 — originalPdfFilename: UID·경로 둘 다 없는 옛 지시서. 이름 정확/유사 매칭으로 폴백
      (시각값 자동 채택은 제거 — 우연 오작동 방지).
    """
    fs_uid = (meta.get("originalFsUid") or "").strip()
    fs_path = (meta.get("originalFsPath") or "").strip()

    # ── 1·2순위: originalFsPath(절대경로)가 살아 있는가 ───────────────────────────
    path_uid_missing: Path | None = None  # 경로는 살아 있는데 ADS 스탬프만 소실된 경우 최후 폴백.
    if fs_path:
        direct = Path(fs_path)
        try:
            is_file = direct.is_file()
        except OSError:
            is_file = False
        if is_file:
            if not fs_uid:
                return direct, "fspath"  # 옛 지시서(UID 없음) — 기존 동작 유지.
            ads = _read_ads_fsuid(direct)
            if ads == fs_uid:
                return direct, "fspath+uid"
            if ads is None:
                # 경로의 .fs 에 스탬프가 없음(비-NTFS 복사 등으로 소실). 경로는 맞을 가능성이
                # 높으나, 먼저 UID 스캔으로 진짜 스탬프된 파일을 찾고 없으면 이 경로로 폴백.
                path_uid_missing = direct
            # ads != fs_uid → 그 경로엔 다른 작업의 .fs 가 놓임. 경로 신뢰 안 함 → UID 스캔으로.

    # ── 1순위(회수): UID 스캔 — 이름이 바뀌거나 옮겨졌어도 ADS 로 정확히 찾는다 ──────────
    if fs_uid and customer_folder is not None:
        try:
            hits = [p for p in customer_folder.rglob("*.fs")
                    if p.is_file() and _read_ads_fsuid(p) == fs_uid]
        except Exception:
            hits = []
        if len(hits) == 1:
            return hits[0], "uid"
        if len(hits) >= 2:
            # 같은 UID 가 여럿(예: .fs 를 복사해 둠) — 가장 최근 수정본 채택.
            best = max(hits, key=lambda p: p.stat().st_mtime)
            return best, f"uid(가장 최근/{len(hits)}건)"

    # 경로의 .fs 는 살아 있는데 스탬프만 소실된 케이스 — UID 스캔도 비었으면 그 경로로 연다.
    if path_uid_missing is not None:
        return path_uid_missing, "fspath(uid-missing)"

    # 경로가 죽었으면 그 .fs 파일명으로 거래처 폴더 재탐색(이동/이름변경 이름 기반 폴백).
    if fs_path and customer_folder is not None:
        relocated, _r = find_fs_file(customer_folder, Path(fs_path).name, fuzzy_threshold)
        if relocated is not None:
            return relocated, "fspath-relocated"

    # ── 3순위: originalPdfFilename 이름 매칭(옛 지시서 전용) ─────────────────────────
    pdf_filename = (meta.get("originalPdfFilename") or "").strip()
    if not pdf_filename:
        return None, ("이 지시서엔 .fs UID·경로도 원본 PDF 파일명도 없어 자동으로 .fs 를 못 찾습니다 "
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


# ─── 입력 잠금 가드 (매크로 중 오조작 방지) ──────────────────────────────────
# [FS에서 열기] Ctrl+O 자동화 동안 작업자의 물리 키보드·마우스를 막는다(사무실 이지폼 입력 가드와
# 동일 방식). 저수준 훅(WH_MOUSE_LL/WH_KEYBOARD_LL)으로 '주입(SendInput)되지 않은' 물리 입력만
# 삼키고, 우리 PowerShell 의 SendKeys(INJECTED 플래그)는 통과시킨다 → 자동화 중 작업자가 키보드·
# 마우스를 건드려도 경로가 깨지거나 엉뚱한 클릭이 안 된다. ESC(물리)는 중단 신호로만 쓴다.
# BlockInput 과 달리 표준 권한으로도 동작하고 창 포커스를 건드리지 않는다. Ctrl+Alt+Del 은 시스템
# 예약이라 영구잠김 위험 없음. 자동화 끝나면 항상 해제.
_guard_abort = threading.Event()
_guard_tid = 0
_guard_refs: list = []  # 콜백 GC 방지(살아 있어야 훅 유효)
_GUARD_AVAILABLE = False
try:
    import ctypes
    from ctypes import wintypes
    _gu = ctypes.windll.user32
    _gk = ctypes.windll.kernel32
    _WH_MOUSE_LL = 14
    _WH_KEYBOARD_LL = 13
    _WM_QUIT = 0x0012
    _LLMHF_INJECTED = 0x00000001
    _LLKHF_INJECTED = 0x00000010
    _VK_ESCAPE = 0x1B
    _LRESULT = ctypes.c_ssize_t
    _HOOKPROC = ctypes.WINFUNCTYPE(_LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

    class _KBDLL(ctypes.Structure):
        _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    class _MSLL(ctypes.Structure):
        _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    _gu.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
    _gu.SetWindowsHookExW.restype = wintypes.HHOOK
    _gu.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    _gu.CallNextHookEx.restype = _LRESULT
    _gu.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
    _gu.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
    _gu.GetMessageW.restype = ctypes.c_int
    _gu.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    _gk.GetCurrentThreadId.restype = wintypes.DWORD
    _gk.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    _gk.GetModuleHandleW.restype = wintypes.HMODULE

    def _mouse_proc(nCode, wParam, lParam):
        if nCode >= 0:
            ms = ctypes.cast(lParam, ctypes.POINTER(_MSLL)).contents
            if not (ms.flags & _LLMHF_INJECTED):
                return 1  # 사용자 물리 마우스 차단(주입된 우리 입력만 통과)
        return _gu.CallNextHookEx(None, nCode, wParam, lParam)

    def _kbd_proc(nCode, wParam, lParam):
        if nCode >= 0:
            kb = ctypes.cast(lParam, ctypes.POINTER(_KBDLL)).contents
            if not (kb.flags & _LLKHF_INJECTED):
                if kb.vkCode == _VK_ESCAPE:
                    _guard_abort.set()  # ESC → 중단 신호
                return 1  # 사용자 물리 키 차단
        return _gu.CallNextHookEx(None, nCode, wParam, lParam)

    def _guard_thread():
        global _guard_tid
        _guard_tid = _gk.GetCurrentThreadId()
        hInst = _gk.GetModuleHandleW(None)
        mp = _HOOKPROC(_mouse_proc)
        kp = _HOOKPROC(_kbd_proc)
        _guard_refs[:] = [mp, kp]
        hM = _gu.SetWindowsHookExW(_WH_MOUSE_LL, mp, hInst, 0)
        hK = _gu.SetWindowsHookExW(_WH_KEYBOARD_LL, kp, hInst, 0)
        msg = wintypes.MSG()
        while _gu.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            pass  # WM_QUIT 오면 종료
        if hM:
            _gu.UnhookWindowsHookEx(hM)
        if hK:
            _gu.UnhookWindowsHookEx(hK)

    _GUARD_AVAILABLE = True
except Exception as _ge:  # noqa: BLE001 — Win32 초기화 실패 시 가드만 비활성, 열기는 그대로 진행
    logging.warning("입력 잠금 가드 비활성(Win32 초기화 실패): %s", _ge)
    _GUARD_AVAILABLE = False


def input_guard_start() -> bool:
    """물리 입력 차단 시작. 성공하면 True. (가드 미가용이면 False — 열기는 계속 진행)"""
    if not _GUARD_AVAILABLE:
        return False
    _guard_abort.clear()
    threading.Thread(target=_guard_thread, daemon=True).start()
    time.sleep(0.06)  # 훅 설치 + 메시지 큐 생성 잠깐 대기
    return True


def input_guard_stop() -> None:
    global _guard_tid
    if _GUARD_AVAILABLE and _guard_tid:
        _gu.PostThreadMessageW(_guard_tid, _WM_QUIT, 0, 0)
        _guard_tid = 0


def input_guard_aborted() -> bool:
    return _guard_abort.is_set()


# ─── 한글 IME 자동 전환 ───────────────────────────────────────────────────────
# 현장 사이드바(Chrome --app)가 검색창에 포커스할 때마다 전면 창의 IME 를 '한글' 로 맞춘다.
# 작업자가 한/영 키를 따로 누르지 않아도 늘 한글이 먼저 쳐지도록. 웹페이지(JS)로는 OS IME 를
# 못 바꾸므로 로컬 에이전트가 IMM32(WM_IME_CONTROL) 로 처리한다 — Chrome(TSF)도 이 메시지를
# 반영함을 확인(set 후 IMC_GETCONVERSIONMODE 에 NATIVE 비트가 켜짐).
_IME_AVAILABLE = False
try:
    import ctypes as _ime_ct
    from ctypes import wintypes as _ime_wt
    _ime_u = _ime_ct.windll.user32
    _ime_imm = _ime_ct.windll.imm32
    _ime_u.GetForegroundWindow.restype = _ime_wt.HWND
    _ime_imm.ImmGetDefaultIMEWnd.restype = _ime_wt.HWND
    _ime_imm.ImmGetDefaultIMEWnd.argtypes = [_ime_wt.HWND]
    _ime_u.SendMessageW.restype = _ime_ct.c_ssize_t
    _ime_u.SendMessageW.argtypes = [_ime_wt.HWND, _ime_wt.UINT, _ime_ct.c_ssize_t, _ime_ct.c_ssize_t]
    _IME_AVAILABLE = True
except Exception as _ie:  # noqa: BLE001 — 실패 시 IME 전환만 비활성(나머지는 그대로)
    logging.warning("한글 IME 전환 비활성(Win32 초기화 실패): %s", _ie)
    _IME_AVAILABLE = False

_WM_IME_CONTROL = 0x0283
_IMC_SETOPENSTATUS = 0x0006
_IMC_SETCONVERSIONMODE = 0x0002
_IME_CMODE_NATIVE = 0x0001   # 한글(영문=0). 절대값 set 이라 토글 아님 — 여러 번 불러도 안전.


def set_ime_korean() -> bool:
    """전면 창(보통 현장 사이드바 Chrome)의 IME 를 한글 입력 상태로 맞춘다. 성공 추정 True.
    open 상태 ON + 변환모드 NATIVE(한글) 를 절대값으로 설정 — 이미 한글이면 그대로 둔다."""
    if not _IME_AVAILABLE:
        return False
    try:
        hwnd = _ime_u.GetForegroundWindow()
        if not hwnd:
            return False
        ime = _ime_imm.ImmGetDefaultIMEWnd(hwnd)
        if not ime:
            return False
        _ime_u.SendMessageW(ime, _WM_IME_CONTROL, _IMC_SETOPENSTATUS, 1)
        _ime_u.SendMessageW(ime, _WM_IME_CONTROL, _IMC_SETCONVERSIONMODE, _IME_CMODE_NATIVE)
        return True
    except Exception as e:  # noqa: BLE001
        logging.debug("IME 한글 전환 실패: %s", e)
        return False


# ─── "여는 중" 안내 배너 ──────────────────────────────────────────────────────
# 입력이 잠긴 동안 작업자가 "멈췄나?" 오해하지 않게 상단 중앙에 작은 띠를 띄운다. 포커스를 절대
# 안 가져가야(WS_EX_NOACTIVATE) FlexiSIGN 열기 자동화를 안 깬다 — 게다가 배너 표시 직후 PS 가
# FlexiSIGN 을 다시 전면화하므로 안전. tkinter 미가용/실패 시 배너만 생략(잠금·열기는 그대로).
#
# ⚠️ 스레드 안전(이 구조의 핵심 이유): tkinter/Tcl 인터프리터는 "만든 스레드"에서만 다뤄야 한다.
# 예전엔 [FS에서 열기] 마다 새 데몬 스레드에서 tk.Tk() 를 만들고 destroy 했는데, destroy 후에도
# 남은 Tcl 객체가 나중에 *다른 스레드*의 GC 로 수거되며
#     Tcl_AsyncDelete: async handler deleted by the wrong thread   (Windows fatal exception 0x80000003)
# 로 프로세스가 통째로 죽었다. 특히 [폴더열기]의 subprocess 호출(_navigate_or_open)이 GC 를
# 유발하는 지점이라, FS 열기 몇 번 뒤 폴더열기를 누르면 에이전트가 꺼지는 증상으로 나타났다.
# → Tk 를 프로세스 생애 동안 "단 하나"만 만들어 전용 UI 스레드에서 영구 보존하고(절대 destroy 안
#   함), 배너는 Toplevel 하나를 withdraw/deiconify 로 재사용한다. show/hide 는 큐로 그 UI 스레드에
#   넘겨 모든 Tcl 호출이 한 스레드 안에서만 일어나게 한다 → 교차 스레드 수거가 원천적으로 불가능.
import queue as _queue

_BANNER_AVAILABLE = False
try:
    import tkinter as _tk_probe  # noqa: F401 — 가용성만 확인(실제 사용은 UI 스레드에서 재import)
    _BANNER_AVAILABLE = True
except Exception:
    _BANNER_AVAILABLE = False

_ui_cmd_q: "_queue.Queue[str]" = _queue.Queue()
_ui_thread_started = False
_ui_thread_lock = threading.Lock()


def _ui_thread_main() -> None:
    """단일 Tk 를 만들어 프로세스 생애 동안 보존하는 전용 UI 스레드. mainloop 는 끝나지 않고,
    Tk/Toplevel 을 destroy 하지 않는다(withdraw 로 숨김). 큐로 들어온 show/hide 만 처리 →
    모든 Tcl 호출이 이 스레드 안에서만 일어나 교차 스레드 GC 수거(Tcl_AsyncDelete)가 불가능."""
    try:
        import tkinter as tk
        import ctypes as _ct
    except Exception:
        return
    try:
        root = tk.Tk()
        root.withdraw()
    except Exception:
        return

    # 색 팔레트(슬레이트 다크 + 스카이 accent).
    CARD, ACCENT, FG, SUB = "#111a2e", "#38bdf8", "#f8fafc", "#94a3b8"
    w, h = 440, 184
    state = {"top": None, "title": None, "shown": False, "tick": 0}

    def _build():
        """배너 Toplevel 을 한 번만 만든다(이후 재사용). 이 함수는 UI 스레드에서만 호출."""
        top = tk.Toplevel(root)
        top.withdraw()
        top.overrideredirect(True)          # 타이틀바 없음(=활성화 안 뺏는 팝업)
        top.attributes("-topmost", True)
        try:
            top.attributes("-alpha", 0.97)
        except Exception:
            pass
        sw, sh = top.winfo_screenwidth(), top.winfo_screenheight()
        # 가로는 정중앙, 세로는 살짝 위(28%) — 정중앙에 뜨는 FlexiSIGN '열기' 대화상자와 안 겹치게.
        x, y = max(0, (sw - w) // 2), max(0, int(sh * 0.28) - h // 2)
        top.geometry("%dx%d+%d+%d" % (w, h, x, y))
        top.configure(bg=ACCENT)            # 1px accent 테두리 효과
        card = tk.Frame(top, bg=CARD)
        card.pack(fill="both", expand=True, padx=2, pady=2)
        tk.Frame(card, bg=ACCENT, height=4).pack(fill="x")   # 상단 accent 바
        body = tk.Frame(card, bg=CARD)
        body.pack(fill="both", expand=True, padx=26, pady=18)
        tk.Label(body, text="🔒", bg=CARD, fg=ACCENT, font=("Segoe UI Emoji", 34)).pack()
        title = tk.Label(body, text="FlexiSIGN에서 여는 중", bg=CARD, fg=FG,
                         font=("맑은 고딕", 15, "bold"))
        title.pack(pady=(8, 2))
        tk.Label(body, text="잠시만 기다려 주세요  ·  ESC 키로 취소", bg=CARD, fg=SUB,
                 font=("맑은 고딕", 10)).pack()
        top.update_idletasks()
        # WS_EX_NOACTIVATE(포커스 안 뺏기) + WS_EX_TOOLWINDOW(작업표시줄 숨김) +
        # WS_EX_TRANSPARENT(클릭 통과 — 혹시 겹쳐도 밑의 열기창으로 클릭 전달).
        try:
            GWL_EXSTYLE = -20
            WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x20, 0x80, 0x08000000
            hwnd = _ct.windll.user32.GetParent(top.winfo_id()) or top.winfo_id()
            cur = _ct.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            _ct.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE,
                                             cur | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)
            _ct.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40)
        except Exception:
            pass
        state["top"], state["title"] = top, title

    def _poll():
        # 큐 명령 소진 — 모든 Tcl 조작은 여기(UI 스레드)에서만.
        try:
            while True:
                cmd = _ui_cmd_q.get_nowait()
                if cmd == "show":
                    if state["top"] is None:
                        try:
                            _build()
                        except Exception:
                            state["top"] = None
                    state["tick"] = 0
                    state["shown"] = True
                    if state["top"] is not None:
                        try:
                            state["top"].deiconify()
                            state["top"].lift()
                        except Exception:
                            pass
                elif cmd == "hide":
                    state["shown"] = False
                    if state["top"] is not None:
                        try:
                            state["top"].withdraw()
                        except Exception:
                            pass
        except _queue.Empty:
            pass
        # 여는 중. → .. → ... 애니메이션(~300ms)
        if state["shown"] and state["title"] is not None:
            state["tick"] += 1
            dots = "." * (1 + (state["tick"] // 6) % 3)
            try:
                state["title"].config(text="FlexiSIGN에서 여는 중" + dots)
            except Exception:
                pass
        root.after(50, _poll)

    root.after(50, _poll)
    try:
        root.mainloop()
    except Exception:
        pass


def _ensure_ui_thread() -> None:
    """배너 UI 스레드를 (한 번만) 띄운다. 데몬이라 프로세스 종료 시 함께 정리."""
    global _ui_thread_started
    if not _BANNER_AVAILABLE:
        return
    with _ui_thread_lock:
        if not _ui_thread_started:
            threading.Thread(target=_ui_thread_main, daemon=True).start()
            _ui_thread_started = True


def banner_show(text: str) -> None:
    # text 는 호환용(현재 배너 문구는 고정). 큐로 UI 스레드에 위임 — Tcl 호출 없음.
    if not _BANNER_AVAILABLE:
        return
    _ensure_ui_thread()
    _ui_cmd_q.put("show")


def banner_hide() -> None:
    if not _BANNER_AVAILABLE:
        return
    _ui_cmd_q.put("hide")


def open_in_flexisign(fs_file: Path) -> tuple[bool, str]:
    """.fs 를 윈도우 기본 연결로 연다(= 탐색기 더블클릭). reopen_in_flexisign 폴백용.

    주의: FlexiSIGN 은 이미 열린 .fs 를 '탐색기 더블클릭/ShellExecute' 로 다시 열면 **새로 안 읽고
    그 창에 포커스만** 준다(검증: 더블클릭=포커스만). 디스크 최종본을 새로 읽으려면 FlexiSIGN
    내부 '파일>열기'(Ctrl+O)를 거쳐야 '다시 여시겠습니까?' 프롬프트가 떠 새 창으로 열린다 →
    그건 reopen_in_flexisign 이 담당. 이 함수는 그게 실패할 때(창 못 찾음 등)의 폴백."""
    try:
        os.startfile(str(fs_file))  # type: ignore[attr-defined]  # Windows 전용
        return True, str(fs_file)
    except Exception as e:
        return False, f".fs 열기 실패({e}) — .fs 가 FlexiSIGN 에 연결돼 있는지 확인하세요."


# FlexiSIGN '파일 > 열기'(Ctrl+O) 자동화 — 탐색기 더블클릭과 달리, 이미 열린 .fs 라도 디스크
# 최종저장본을 **새 창으로** 열 수 있는 유일한 경로(FlexiSIGN 이 File>Open 때만 '다시 여시겠습니까?'
# 프롬프트를 띄움). 동작: FlexiSIGN 활성화 → (자기 모달 있으면 Esc) → Ctrl+O → 경로 붙여넣기 →
# Enter(파일 선택) → '다시 여시겠습니까?' 프롬프트가 뜨면 그게 reopen 프롬프트일 때만 Enter 로 확정.
#
# 안전장치(사장님 요구 반영):
#  - 오조작 방지: 키 전송 동안 BlockInput 으로 작업자의 물리 키보드·마우스를 잠근다(합성 SendKeys
#    는 통과). finally 로 반드시 해제 → 잠긴 채 안 남음.
#  - 저장 사고 방지: 파일 선택 후 뜨는 프롬프트가 '다시 여시겠습니까?'(reopen)일 때만 자동 Enter.
#    '변경 저장?'(저장) 류면 절대 자동으로 안 누르고 작업자에게 맡긴다(미저장 작업 무단 저장 방지).
#  - DesignCentral/Fill·Stroke 같은 도구 패널(#32770 아님)·타 앱 창(PID 다름)은 안 건드림.
# 출력(stdout): OK(이미 안 열려 있어 새 창) / OK_REOPENED(reopen 프롬프트 자동 확정) /
#   OK_PROMPT(프롬프트 떴으나 저장류/불명이라 작업자 대기, 다음 줄 PROMPT|제목|버튼들) /
#   NOFLEXI / BLOCKED / NODLG. OK* 는 성공, 나머지는 호출부가 os.startfile 폴백.
_REOPEN_FS_PS = r"""
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HDWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool BlockInput(bool block);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
  // 다른 프로세스(예: Chrome 사이드바)가 전면일 때 FlexiSIGN 을 전면으로 끌어올린다.
  // AppActivate/단순 SetForegroundWindow 는 '포그라운드 잠금 타임아웃' 때문에 실패한다(로그상 forceFg=False).
  //   → ① 잠금 타임아웃을 0 으로(SPI_SETFOREGROUNDLOCKTIMEOUT) ② 현재 전면 스레드에 AttachThreadInput
  //      으로 붙어 ③ SetForegroundWindow + BringWindowToTop. 반환은 '실제로 전면이 됐는가' 로 판정.
  public static bool ForceForeground(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
    SystemParametersInfo(0x2001 /*SPI_SETFOREGROUNDLOCKTIMEOUT*/, 0, IntPtr.Zero, 2 /*SPIF_SENDCHANGE*/);
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint myThread = GetCurrentThreadId();
    bool attached = (fgThread != 0 && fgThread != myThread && AttachThreadInput(myThread, fgThread, true));
    SetForegroundWindow(hwnd);
    BringWindowToTop(hwnd);
    ShowWindow(hwnd, 5); // SW_SHOW
    if (attached) AttachThreadInput(myThread, fgThread, false);
    return GetForegroundWindow() == hwnd;
  }
  public static string ChildTexts(IntPtr parent) {
    var sb = new StringBuilder();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var s = t.ToString().Trim();
      if (s.Length > 0) { sb.Append(s); sb.Append(" / "); }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
function FgClass {
  $sb = New-Object System.Text.StringBuilder 256
  [void][HDWin]::GetClassName([HDWin]::GetForegroundWindow(), $sb, 256)
  $sb.ToString()
}
function FgPid {
  $p = [uint32]0
  [void][HDWin]::GetWindowThreadProcessId([HDWin]::GetForegroundWindow(), [ref]$p)
  $p
}
$names = @()
if ($env:HD_FS_PROCS) { $names = ($env:HD_FS_PROCS -split ';') | Where-Object { $_ } }
$proc = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    ($names -contains $_.ProcessName.ToLower()) -or
    ($_.MainWindowTitle -match 'FlexiSIGN') -or ($_.MainWindowTitle -match '\.fs')
  )
} | Select-Object -First 1
if (-not $proc) { Write-Output 'NOFLEXI'; exit }
$mainH = $proc.MainWindowHandle
[void][HDWin]::BlockInput($true)
try {
  # FlexiSIGN 메인창을 전면으로 — 다른 앱(Chrome 사이드바)이 전면이면 잠금 때문에 한 번에 안 될 수
  # 있어 여러 번 시도하며 실제 전면이 될 때까지 폴링한다.
  $got = $false
  for ($a = 0; $a -lt 10; $a++) {
    if ([HDWin]::ForceForeground($mainH)) { $got = $true; break }
    Start-Sleep -Milliseconds 120
    if ((FgPid) -eq $proc.Id) { $got = $true; break }
  }
  [Console]::Error.WriteLine(("[reopen] activate: got={0} fgPid={1} fgClass={2} (flexiPid={3})" -f $got, (FgPid), (FgClass), $proc.Id))
  if (-not $got) { Write-Output 'NOFG'; return }   # 전면화 실패 → ^o 가 엉뚱한 창에 가므로 폴백.
  # FlexiSIGN 자기 소유의 모달(#32770)이 떠 있으면 Esc 로 닫는다(도구 패널·타 앱 창 제외).
  for ($k = 0; $k -lt 5; $k++) {
    if ((FgClass) -eq '#32770' -and (FgPid) -eq $proc.Id) {
      [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
      Start-Sleep -Milliseconds 180
      [void][HDWin]::ForceForeground($mainH)
      Start-Sleep -Milliseconds 100
    } else { break }
  }
  if ((FgClass) -eq '#32770' -and (FgPid) -eq $proc.Id) { Write-Output 'BLOCKED'; return }
  [void][HDWin]::ForceForeground($mainH)
  Start-Sleep -Milliseconds 120
  if ((FgPid) -ne $proc.Id) { Write-Output 'NOFG'; return }
  [System.Windows.Forms.SendKeys]::SendWait('^o')
  $opened = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if ((FgClass) -eq '#32770' -and (FgPid) -eq $proc.Id) { $opened = $true; break }
  }
  if (-not $opened) { Write-Output 'NODLG'; return }
  $openH = [HDWin]::GetForegroundWindow()
  Set-Clipboard -Value $env:HD_FS_PATH
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  # 파일 선택 후 FlexiSIGN 이 새 프롬프트(#32770, openH 와 다른 창)를 띄우는지 ~1.5초 관찰.
  $prompt = [IntPtr]::Zero
  for ($j = 0; $j -lt 15; $j++) {
    Start-Sleep -Milliseconds 100
    $fg = [HDWin]::GetForegroundWindow()
    if ((FgClass) -eq '#32770' -and (FgPid) -eq $proc.Id -and $fg -ne $openH) { $prompt = $fg; break }
  }
  if ($prompt -eq [IntPtr]::Zero) { Write-Output 'OK'; return }  # 안 열려 있던 파일 → 새 창으로 바로 열림.
  $pt = New-Object System.Text.StringBuilder 256
  [void][HDWin]::GetWindowText($prompt, $pt, 256)
  $kids = [HDWin]::ChildTexts($prompt)
  $msg = ($pt.ToString() + ' ' + $kids)
  # '저장' 류 프롬프트면 절대 자동 확정 안 함(미저장 작업 보호). reopen 프롬프트일 때만 Enter.
  if ($msg -match '저장|save') {
    Write-Output 'OK_PROMPT'
    Write-Output ("PROMPT|{0}|{1}" -f $pt.ToString(), $kids)
    return
  }
  if ($msg -match '여시|다시|이미 열|already|reopen|re-open') {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')   # '다시 여시겠습니까?' = 예 → 디스크본 새로
    Write-Output 'OK_REOPENED'
    return
  }
  # 정체불명 프롬프트 — 자동으로 안 누르고 작업자에게.
  Write-Output 'OK_PROMPT'
  Write-Output ("PROMPT|{0}|{1}" -f $pt.ToString(), $kids)
} finally {
  [void][HDWin]::BlockInput($false)
}
"""


def reopen_in_flexisign(fs_file: Path, config: dict) -> tuple[bool, str]:
    """FlexiSIGN '파일>열기'(Ctrl+O) 자동화로 .fs 의 최종저장본을 새 창으로 연다. 반환 (성공, 사유).
    창/대화상자 자동화라 실패할 수 있음 — 그 경우 (False, 사유) 로 호출부가 os.startfile 폴백."""
    exe = resolve_flexisign_exe(config.get("flexisign_exe"))
    procs = ";".join(
        (n[:-4] if n.lower().endswith(".exe") else n)
        for n in _flexisign_process_names(exe, config)
    )
    env = dict(os.environ)
    env["HD_FS_PATH"] = str(fs_file)
    env["HD_FS_PROCS"] = procs
    # 자동화(Ctrl+O→경로 붙여넣기→Enter) 동안 작업자 물리 입력을 잠가 오조작을 막는다.
    # 우리 SendKeys 는 주입 입력이라 통과. 작업자가 물리 ESC 를 누르면 즉시 중단(프로세스 종료).
    locked = input_guard_start()
    if locked:
        logging.info("입력 잠금 ON — 자동 열기 중 키보드/마우스 차단(ESC 취소)")
    banner_show("🔒 FlexiSIGN에서 여는 중…  잠시 기다려 주세요  (ESC 취소)")
    try:
        try:
            proc = subprocess.Popen(
                ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
                 "-Command", _REOPEN_FS_PS],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:
            return False, f"FlexiSIGN 자동 열기 실행 실패: {e}"
        aborted = False
        deadline = time.monotonic() + 15  # 백스톱(정상 ~2-3초). 멈춰도 이만큼 뒤엔 잠금 해제.
        while proc.poll() is None:
            if locked and input_guard_aborted():
                aborted = True
                proc.kill()
                break
            if time.monotonic() > deadline:
                proc.kill()
                break
            time.sleep(0.1)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = "", ""
    finally:
        input_guard_stop()
        banner_hide()
    out = out or ""
    if aborted:
        logging.info("reopen_in_flexisign 사용자 ESC 중단")
        return False, "사용자가 ESC 로 열기를 취소했습니다."
    logging.info("reopen_in_flexisign out=%r", out.strip()[:200])
    if err:  # 단계별 Trace(activate/NOFG 등) — 원인 추적용.
        logging.info("reopen_in_flexisign trace=%r", err.strip()[:600])
    if "OK_PROMPT" in out:
        prompt = next((ln for ln in out.splitlines() if ln.startswith("PROMPT|")), "")
        if prompt:
            logging.warning("reopen_in_flexisign 프롬프트 대기(작업자 처리): %s", prompt[:300])
        return True, str(fs_file)   # 파일은 선택됨 — 작업자가 프롬프트 확정하면 열림.
    if "OK_REOPENED" in out or "OK" in out:
        return True, str(fs_file)
    if "NOFLEXI" in out:
        return False, "FlexiSIGN 창을 찾지 못했습니다(최소화/미실행)."
    if "NOFG" in out:
        return False, "FlexiSIGN 창을 전면으로 올리지 못했습니다(포커스 잠금)."
    if "BLOCKED" in out:
        return False, "FlexiSIGN 모달 창을 닫지 못해 열기를 진행하지 못했습니다."
    if "NODLG" in out:
        return False, "FlexiSIGN 열기 대화상자가 뜨지 않았습니다."
    return False, "FlexiSIGN 자동 열기 미확인."


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
        # /health·/ime-korean 은 너무 자주 와서(창 포커스마다) 로그를 막는다 — 진단 가독성 유지.
        msg = format % args
        if "/ime-korean" in msg or "/health" in msg:
            return
        logging.info("%s - %s", self.address_string(), msg)

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
        if parsed.path not in ("/open", "/open-folder", "/ime-korean"):
            self.send_response(404)
            self._send_cors(origin)
            self.end_headers()
            return

        # custom header 검사 — preflight 우회 시도 차단(X-HDSign-Field 가 없으면 거부).
        if self.headers.get("X-HDSign-Field") != "1":
            self._send_json(400, {"message": "X-HDSign-Field 헤더 필요"}, origin)
            return

        # /ime-korean — 검색창 포커스 시 전면 창 IME 를 한글로. orderNumber 불필요, 즉시 처리.
        if parsed.path == "/ime-korean":
            self._send_json(200, {"ok": set_ime_korean()}, origin)
            return

        # 본문 비우기 — 위에서 즉시 응답한 경로가 아닌 /open·/open-folder 만 여기로 온다.
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
        # 1순위 — FlexiSIGN '파일>열기'(Ctrl+O) 자동화로 디스크 최종본을 새 창으로 연다(탐색기
        # 더블클릭은 이미 열린 파일에 포커스만 주므로 안 됨). BlockInput 으로 자동화 중 오조작 차단,
        # '다시 여시겠습니까?' reopen 프롬프트만 자동 확정('저장' 류는 작업자에게). 실패 시 os.startfile 폴백.
        ok, info = reopen_in_flexisign(fs_file, config)
        if not ok:
            logging.info("FS 자동 열기 폴백(os.startfile) [%s]: %s", order_number, info)
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("종료 요청 — 서버 정리")
    finally:
        server.server_close()


def _log_file_path() -> Path:
    """진단용 로그 파일 경로 — 정식(창 없음) 빌드는 콘솔이 없어 로그가 사라지므로 파일로도 남긴다."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    d = Path(base) / "HDSignFieldViewer"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        return Path(base) / "hdsign_field_agent.log"
    return d / "agent.log"


def main() -> None:
    handlers: list = [logging.StreamHandler()]  # 디버그(콘솔) 빌드용.
    try:
        from logging.handlers import RotatingFileHandler
        fh = RotatingFileHandler(str(_log_file_path()), maxBytes=1_000_000,
                                 backupCount=3, encoding="utf-8")
        handlers.append(fh)  # 정식 빌드에서도 reopen rc/out·trace 를 파일로 확인 가능.
    except Exception:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )
    logging.info("로그 파일: %s", _log_file_path())
    config = load_config()
    serve_forever(config)


if __name__ == "__main__":
    main()
