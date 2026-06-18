# fs_handle.py — FlexiSIGN 이 '열어 둔' .fs 파일의 실제 전체 경로를 OS 핸들에서 읽는다.
#
# 왜 필요한가: FlexiSIGN 창 제목엔 파일'명'만 있고 폴더 경로가 없다. 그래서 같은 이름 .fs 가
# 여러 폴더에 있거나(예: '시트커팅' 수십 개) 거래처 폴더가 갈리면 이름검색이 엉뚱한 파일을
# 잡거나 못 찾는다. 프로세스가 연 파일 핸들에서 '실제 전체 경로'를 얻어 인쇄한 바로 그 .fs 를
# 정확히 특정한다 → 워처가 originalFsPath/UID 를 정확히 박고, 현장 [FS에서 열기] 가 그 경로로 직행.
#
# 안전: 어떤 실패도 예외를 밖으로 던지지 않고 [] / None 반환. 동기 파이프 등에서 NtQueryObject 가
# 멈추는 알려진 GrantedAccess 값은 건너뛴다(호출측은 추가로 스레드+타임아웃으로 한 번 더 보호).
from __future__ import annotations

import ctypes
import os
import unicodedata
from ctypes import wintypes

try:
    _ntdll = ctypes.WinDLL("ntdll")
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _AVAILABLE = True
except Exception:
    _AVAILABLE = False

_SystemExtendedHandleInformation = 0x40
_STATUS_INFO_LENGTH_MISMATCH = ctypes.c_long(0xC0000004).value
_ObjectNameInformation = 1
_PROCESS_DUP_HANDLE = 0x0040
_DUPLICATE_SAME_ACCESS = 0x0002
# 동기 파이프 등에서 NtQueryObject(name) 가 멈추는 알려진 GrantedAccess 값 — 건너뛴다.
_HANG_ACCESS = frozenset((0x0012019F, 0x00120189, 0x0012008D, 0x00100000))

_ULONG_PTR = ctypes.c_size_t


class _HANDLE_ENTRY(ctypes.Structure):
    _fields_ = [
        ("Object", ctypes.c_void_p),
        ("UniqueProcessId", _ULONG_PTR),
        ("HandleValue", _ULONG_PTR),
        ("GrantedAccess", wintypes.ULONG),
        ("CreatorBackTraceIndex", wintypes.USHORT),
        ("ObjectTypeIndex", wintypes.USHORT),
        ("HandleAttributes", wintypes.ULONG),
        ("Reserved", wintypes.ULONG),
    ]


class _UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


if _AVAILABLE:
    _ntdll.NtQuerySystemInformation.restype = ctypes.c_long
    _ntdll.NtQuerySystemInformation.argtypes = [
        ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    _ntdll.NtQueryObject.restype = ctypes.c_long
    _ntdll.NtQueryObject.argtypes = [
        wintypes.HANDLE, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel32.DuplicateHandle.restype = wintypes.BOOL
    _kernel32.DuplicateHandle.argtypes = [
        wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.GetLogicalDrives.restype = wintypes.DWORD
    _kernel32.QueryDosDeviceW.restype = wintypes.DWORD
    _kernel32.QueryDosDeviceW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]


def _drive_map() -> dict:
    r"""\Device\HarddiskVolumeN -> 'C:' 매핑(네트워크 드라이브 Z: 포함)."""
    m = {}
    try:
        bitmask = _kernel32.GetLogicalDrives()
        buf = ctypes.create_unicode_buffer(1024)
        for i in range(26):
            if not (bitmask >> i) & 1:
                continue
            drive = f"{chr(65 + i)}:"
            if _kernel32.QueryDosDeviceW(drive, buf, 1024):
                m[buf.value] = drive
    except Exception:
        pass
    return m


def _nt_to_dos(nt_path: str, dmap: dict) -> str:
    r"""NT 디바이스 경로(\Device\HarddiskVolume3\..., \Device\Mup\Main\공유\...)를 DOS 경로로."""
    low = nt_path.lower()
    for dev, drive in dmap.items():
        d = dev.lower()
        if low.startswith(d + "\\") or low == d:
            return drive + nt_path[len(dev):]
    # 네트워크(UNC): \Device\Mup\<host>\<share>\... → \\<host>\<share>\...
    for pre in (r"\Device\Mup", r"\Device\LanmanRedirector"):
        if low.startswith(pre.lower() + "\\"):
            return "\\" + nt_path[len(pre):]
    return nt_path


def list_open_files(pid: int, suffix: str = ".fs", timeout_ms: int = 0) -> list:
    """pid 프로세스가 연 파일 핸들 중 경로가 suffix(소문자)로 끝나는 DOS 경로 목록."""
    if not _AVAILABLE or not pid:
        return []
    suffix = suffix.lower()
    try:
        info_len = 0x200000
        buf = None
        for _ in range(8):
            buf = ctypes.create_string_buffer(info_len)
            ret = ctypes.c_ulong(0)
            st = _ntdll.NtQuerySystemInformation(
                _SystemExtendedHandleInformation, buf, info_len, ctypes.byref(ret))
            if st == 0:
                break
            if st == _STATUS_INFO_LENGTH_MISMATCH:
                info_len = max(ret.value + 0x10000, info_len * 2)
                if info_len > 128 * 1024 * 1024:
                    return []
                continue
            return []
        else:
            return []

        number = _ULONG_PTR.from_buffer(buf, 0).value
        base = ctypes.sizeof(_ULONG_PTR) * 2
        if number <= 0 or number > 5_000_000:
            return []
        arr = (_HANDLE_ENTRY * number).from_buffer(buf, base)

        hproc = _kernel32.OpenProcess(_PROCESS_DUP_HANDLE, False, pid)
        if not hproc:
            return []
        cur = _kernel32.GetCurrentProcess()
        dmap = _drive_map()
        out = []
        try:
            for i in range(number):
                ent = arr[i]
                if ent.UniqueProcessId != pid:
                    continue
                if ent.GrantedAccess in _HANG_ACCESS:
                    continue
                dup = wintypes.HANDLE()
                if not _kernel32.DuplicateHandle(
                        hproc, wintypes.HANDLE(ent.HandleValue), cur,
                        ctypes.byref(dup), 0, False, _DUPLICATE_SAME_ACCESS):
                    continue
                try:
                    nbuf = ctypes.create_string_buffer(2048)
                    rl = ctypes.c_ulong(0)
                    if _ntdll.NtQueryObject(dup, _ObjectNameInformation, nbuf, 2048, ctypes.byref(rl)) == 0:
                        us = _UNICODE_STRING.from_buffer_copy(nbuf, 0)
                        if us.Length and us.Buffer:
                            name = ctypes.wstring_at(us.Buffer, us.Length // 2)
                            if name.lower().endswith(suffix):
                                out.append(_nt_to_dos(name, dmap))
                finally:
                    _kernel32.CloseHandle(dup)
            return out
        finally:
            _kernel32.CloseHandle(hproc)
    except Exception:
        return []


def open_fs_path(pid: int, stem: str) -> str | None:
    """pid 가 연 .fs 중 파일명(stem)이 일치하는 첫 전체경로. 없으면 None."""
    if not stem:
        return None
    target = unicodedata.normalize("NFC", stem).casefold()
    for p in list_open_files(pid, ".fs"):
        b = os.path.splitext(os.path.basename(p))[0]
        if unicodedata.normalize("NFC", b).casefold() == target:
            return p
    return None


if __name__ == "__main__":
    # 스모크 테스트 — 이 프로세스가 연 파일을 스스로 찾아본다.
    import sys
    import tempfile
    tf = os.path.join(tempfile.gettempdir(), "_fs_handle_selftest.fs")
    with open(tf, "w", encoding="utf-8") as f:
        f.write("test")
    fh = open(tf, "r", encoding="utf-8")  # 핸들 열어 둠
    try:
        pid = os.getpid()
        print("pid =", pid)
        found = list_open_files(pid, ".fs")
        print("list_open_files(.fs) =", found)
        print("open_fs_path(stem) =", open_fs_path(pid, "_fs_handle_selftest"))
    finally:
        fh.close()
        try:
            os.remove(tf)
        except Exception:
            pass
