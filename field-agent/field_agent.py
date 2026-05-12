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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ─── 설정 ─────────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    # 백엔드 API 베이스. 운영/개발 모두 같은 키.
    "api_base": "https://hdsign-production.up.railway.app",
    # 사무실 워처와 동일한 키 — 같은 config 를 공유해도 안전하도록 같은 이름 사용.
    "network_customer_base": r"\\Main\공유\거래처",
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
        pdf_filename = (meta.get("originalPdfFilename") or "").strip()
        if not network_folder_name and not company:
            return {"opened": False, "message": "거래처 정보가 비어있어 폴더를 찾을 수 없습니다."}

        network_base = Path(network_base_str)
        customer_folder = find_customer_folder(network_base, network_folder_name, company)
        if customer_folder is None:
            return {
                "opened": False,
                "message": f"거래처 폴더를 찾지 못했습니다: {network_folder_name or company}",
            }

        # 옛 지시서(워처가 originalPdfFilename 을 보내기 전에 올라간 건) — 매칭할 PDF 명이
        # 없으니 .fs 자동 매칭은 불가. 그래도 거래처 폴더는 열어줘서 사용자가 직접 .fs 를
        # 고르게 한다(버튼이 죽어있는 것보다 낫다 — 일괄 재업로드 불필요).
        if not pdf_filename:
            open_folder_in_explorer(customer_folder)
            return {
                "opened": False,
                "message": "이 지시서엔 원본 PDF 파일명이 없어 자동으로 .fs 를 못 찾습니다 "
                           "(워처가 새로 인쇄·'웹에 적용' 하면 다음부턴 자동). 거래처 폴더를 열었습니다 — .fs 를 직접 골라주세요.",
                "customerFolder": str(customer_folder),
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
