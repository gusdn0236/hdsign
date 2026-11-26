"""사무실 워처 — 껐다 켜지 않는 업데이트(사용자 2026-11-26).

흐름
  1) 1분마다 네트워크 마스터(Z:\\worksheet-program\\hdsign_worksheet\\hdsign_version.txt)를 보고 지금 버전과 다르면
     워처 창에 [업데이트하기].
  2) 누르면 새 파일을 **다른 칸 폴더**에 받는다(C:\\HDSign\\hdsign_worksheet ↔ C:\\HDSign\\hdsign_worksheet_b 번갈아).
     지금 돌고 있는 파일은 안 건드리므로 받는 동안(퍼센트 표시) 워처는 평소처럼 쓴다.
  3) 다 받으면 하던 작업(지시서 처리·이지폼 작업·열린 창)이 끝나길 기다렸다가 바꾼다:
     옛 워처가 새 요청에 '업데이트 중'(503)으로 답하기 시작 → 새 워처를 띄움 → 새 워처가 준비되면(READY 신호)
     옛 워처가 폴더 감시·포트를 놓고(RELEASED 신호) 꺼짐 → 새 워처가 바로 이어받음. 홈페이지는 503/연결끊김을 보면
     '업데이트 중이에요'를 띄우고 새 워처가 답할 때까지 기다렸다 같은 요청을 다시 보낸다.
  4) 새 워처가 90초 안에 준비 안 되면 바꾸기 취소 — 옛 워처가 그대로 계속.
다음에 PC 를 켜고 바로가기를 누르면 원래대로 Z: → C:\\HDSign\\hdsign_worksheet 로 맞춰 실행된다(launch .bat).
"""
from __future__ import annotations

import ctypes
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

VERSION_FILE = "hdsign_version.txt"
EXE_NAME = "hdsign_worksheet.exe"
MASTERS = (r"Z:\worksheet-program\hdsign_worksheet", r"\\Main\현대공유\worksheet-program\hdsign_worksheet")
SLOT_A = Path(r"C:\HDSign\hdsign_worksheet")
SLOT_B = Path(r"C:\HDSign\hdsign_worksheet_b")
EV_READY = "Local\\HDSignWatcherTakeoverReady"        # 새 워처 → 옛 워처: 이어받을 준비 됨
EV_RELEASED = "Local\\HDSignWatcherTakeoverReleased"  # 옛 워처 → 새 워처: 감시·포트 놓음

_k32 = ctypes.windll.kernel32
_k32.CreateEventW.restype = ctypes.c_void_p
_k32.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p]
_k32.SetEvent.argtypes = [ctypes.c_void_p]
_k32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
_k32.CloseHandle.argtypes = [ctypes.c_void_p]

_LK = threading.Lock()
# phase: idle | available | downloading | waiting | swapping | failed
STATE = {"phase": "idle", "pct": 0, "current": "", "latest": "", "message": ""}
_HOOKS: dict = {"busy": None, "release": None, "saved_printer": None}


def _set(**kw) -> None:
    with _LK:
        STATE.update(kw)


def snapshot() -> dict:
    with _LK:
        return dict(STATE)


def blocking() -> bool:
    """옛 워처가 새 워처에게 넘기는 중 — 홈페이지 요청엔 '업데이트 중'으로 답한다."""
    with _LK:
        return STATE["phase"] == "swapping"


def app_dir() -> "Path | None":
    if not getattr(sys, "frozen", False):
        return None
    return Path(sys.executable).resolve().parent


def _read_version(d: "Path | str | None") -> str:
    if not d:
        return ""
    try:
        return (Path(d) / VERSION_FILE).read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def current_version() -> str:
    return _read_version(app_dir())


def _master() -> "Path | None":
    for m in MASTERS:
        try:
            if (Path(m) / VERSION_FILE).exists():
                return Path(m)
        except Exception:
            pass
    return None


def enabled() -> bool:
    """빌드된 워처가 두 칸 폴더 중 하나에서 돌 때만(개발 중 소스 실행·다른 위치는 안 함)."""
    d = app_dir()
    if not d:
        return False
    try:
        return d in (SLOT_A.resolve(), SLOT_B.resolve())
    except Exception:
        return False


def _other_slot() -> Path:
    d = app_dir()
    return SLOT_A if d and d == SLOT_B.resolve() else SLOT_B


# ── 1) 새 버전 확인 ─────────────────────────────────────────────────────────────
def start(busy, release, saved_printer) -> None:
    """워처 시작 때 한 번. busy()=지금 하던 작업 있나, release()=감시·포트 놓기(옛 워처), saved_printer()=원래 기본 프린터."""
    _HOOKS.update(busy=busy, release=release, saved_printer=saved_printer)
    _set(current=current_version())
    if not enabled():
        return

    def loop():
        while True:
            try:
                if snapshot()["phase"] in ("idle", "available"):
                    m = _master()
                    mv = _read_version(m) if m else ""
                    cur = snapshot()["current"]
                    if mv and mv != cur:
                        if snapshot()["phase"] != "available" or snapshot()["latest"] != mv:
                            logging.info("워처 새 버전 있음: %s → %s", cur or "?", mv)
                        _set(phase="available", latest=mv, message="")
                    elif snapshot()["phase"] == "available":
                        _set(phase="idle", latest="")
            except Exception:
                logging.exception("워처 새 버전 확인 실패")
            time.sleep(60)

    threading.Thread(target=loop, daemon=True, name="self-update-check").start()


# ── 2) 받기(다른 칸 폴더) ───────────────────────────────────────────────────────
def _files(root: Path) -> dict:
    out = {}
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            p = Path(dp) / f
            try:
                st = p.stat()
            except OSError:
                continue
            out[str(p.relative_to(root))] = (st.st_size, st.st_mtime)
    return out


def _same(a, b) -> bool:
    return a is not None and b is not None and a[0] == b[0] and abs(a[1] - b[1]) < 2.1


def _copy(src: Path, dst: Path, on_bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".hdpart")
    with open(src, "rb") as fi, open(tmp, "wb") as fo:
        while True:
            buf = fi.read(1 << 20)
            if not buf:
                break
            fo.write(buf)
            on_bytes(len(buf))
    os.replace(tmp, dst)
    st = src.stat()
    os.utime(dst, (st.st_atime, st.st_mtime))  # 시각까지 맞춰 둬야 다음엔 바뀐 것만 받는다


def _stage(master: Path, dst: Path, seed: "Path | None", want: str) -> None:
    src_files = _files(master)
    src_files.pop(VERSION_FILE, None)
    have = _files(dst) if dst.exists() else {}
    seed_files = _files(seed) if seed and seed.exists() else {}
    todo = [(rel, meta) for rel, meta in src_files.items() if not _same(have.get(rel), meta)]
    total = sum(m[0] for _r, m in todo) or 1
    done = [0]
    last = [0.0]

    def on_bytes(n):
        done[0] += n
        if time.time() - last[0] > 0.2:
            last[0] = time.time()
            _set(pct=min(99, int(done[0] * 100 / total)))

    for rel, meta in todo:
        local = seed / rel if seed and _same(seed_files.get(rel), meta) else None
        _copy(local or (master / rel), dst / rel, on_bytes)  # 같은 파일이 지금 폴더에 있으면 네트워크 대신 그걸 복사
    # 마스터에 없는 파일 정리
    for rel in set(_files(dst)) - set(src_files) - {VERSION_FILE}:
        try:
            (dst / rel).unlink()
        except OSError:
            pass
    for dp, dn, fn in sorted(os.walk(dst), key=lambda x: -len(x[0])):
        if dp != str(dst) and not dn and not fn:
            try:
                os.rmdir(dp)
            except OSError:
                pass
    if _read_version(master) != want:
        raise RuntimeError("받는 중에 새 버전이 또 올라왔어요")
    (dst / VERSION_FILE).write_text(want, encoding="utf-8")  # 버전 표시는 맨 마지막(다 받았다는 뜻)


def begin() -> bool:
    """[업데이트하기] — 받기 → 작업 끝나길 기다림 → 바꾸기. 이미 진행 중이면 False."""
    with _LK:
        if STATE["phase"] not in ("available", "failed"):
            return False
        STATE.update(phase="downloading", pct=0, message="")
    threading.Thread(target=_run, daemon=True, name="self-update").start()
    return True


def _run() -> None:
    try:
        for _try in range(3):
            m = _master()
            if not m:
                raise RuntimeError("지금 새 버전을 올리는 중이거나 네트워크 폴더(Z:)에 접근할 수 없어요. 잠시 뒤 다시 해주세요")
            want = _read_version(m)
            dst = _other_slot()
            logging.info("워처 업데이트 받기: %s → %s", want, dst)
            try:
                _stage(m, dst, app_dir(), want)
                break
            except RuntimeError as e:
                if "또 올라왔" not in str(e):
                    raise
                time.sleep(3)
        else:
            raise RuntimeError("새 버전이 계속 바뀌어서 받지 못했어요. 잠시 뒤 다시 해주세요")
        if not (dst / EXE_NAME).exists():
            raise RuntimeError("받은 폴더에 워처 프로그램이 없어요")
        _set(pct=100, latest=want)
        # 3) 하던 작업 끝나길 기다림
        busy = _HOOKS["busy"]
        while busy and busy():
            _set(phase="waiting", message="")
            time.sleep(1)
        _swap(dst)
    except Exception as e:  # noqa: BLE001
        logging.exception("워처 업데이트 실패")
        _set(phase="failed", message=str(e))


# ── 3) 바꾸기 ───────────────────────────────────────────────────────────────────
def _swap(dst: Path) -> None:
    _set(phase="swapping", message="")
    ev_ready = _k32.CreateEventW(None, 1, 0, EV_READY)
    ev_rel = _k32.CreateEventW(None, 1, 0, EV_RELEASED)
    try:
        args = [str(dst / EXE_NAME), "--takeover", str(os.getpid())]
        sp = _HOOKS["saved_printer"]() if _HOOKS["saved_printer"] else None
        if sp:
            args += ["--saved-printer", sp]
        logging.info("워처 업데이트: 새 워처 실행 %s", args)
        proc = subprocess.Popen(args, cwd=str(dst), close_fds=True)
        t0 = time.time()
        while _k32.WaitForSingleObject(ev_ready, 300) != 0:
            if proc.poll() is not None:
                raise RuntimeError("새 워처가 켜지다가 꺼졌어요(지금 워처는 그대로 써요)")
            if time.time() - t0 > 90:
                try:
                    proc.kill()
                except Exception:
                    pass
                raise RuntimeError("새 워처가 준비되지 않아 바꾸기를 취소했어요(지금 워처는 그대로 써요)")
        logging.info("워처 업데이트: 새 워처 준비됨 → 넘겨줌")
        try:
            if _HOOKS["release"]:
                _HOOKS["release"]()  # 폴더 감시 멈춤 + 포트 놓기 + 화면 닫기 예약
        finally:
            _k32.SetEvent(ev_rel)
        time.sleep(0.3)
        logging.info("워처 업데이트: 옛 워처 끝")
        os._exit(0)
    except Exception:
        _set(phase="failed")
        raise
    finally:
        _k32.CloseHandle(ev_ready)
        _k32.CloseHandle(ev_rel)


# ── 새 워처 쪽 ──────────────────────────────────────────────────────────────────
def takeover_args(argv: list) -> dict:
    out = {"pid": 0, "saved_printer": ""}
    for i, a in enumerate(argv):
        if a == "--takeover" and i + 1 < len(argv):
            try:
                out["pid"] = int(argv[i + 1])
            except ValueError:
                pass
        if a == "--saved-printer" and i + 1 < len(argv):
            out["saved_printer"] = argv[i + 1]
    return out


def takeover_handshake(timeout: float = 30.0) -> None:
    """새 워처 — 폴더 감시·포트를 열기 **직전**에 부른다. 준비 신호 → 옛 워처가 놓을 때까지 기다림."""
    ev_ready = _k32.CreateEventW(None, 1, 0, EV_READY)
    ev_rel = _k32.CreateEventW(None, 1, 0, EV_RELEASED)
    try:
        _k32.SetEvent(ev_ready)
        r = _k32.WaitForSingleObject(ev_rel, int(timeout * 1000))
        logging.info("워처 업데이트: 이어받기 %s", "완료" if r == 0 else "시간초과(그냥 시작)")
    finally:
        _k32.CloseHandle(ev_ready)
        _k32.CloseHandle(ev_rel)
