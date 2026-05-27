"""클립보드 format dump v2 — ctypes 시그니처 명시 + 파일 출력 + 대기 모드.

사용법:
    1. PowerShell 에서 미리 실행:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\clipboard_inspect.py
    2. "이제 이지폼에서 [물품내역 복사하기] 누르고 Enter ↩" 메시지 뜨면
    3. 이지폼으로 돌아가 명세서 더블클릭 → [물품내역 복사하기]
    4. PowerShell 로 돌아와 Enter
    5. 화면 출력 + C:\\Users\\USER\\Desktop\\clipboard_dump.txt 파일 양쪽에 저장됨
    6. 출력 또는 파일 내용 보내주세요
"""
from __future__ import annotations
import ctypes
import sys
import traceback
from ctypes import wintypes
from pathlib import Path

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Signature 명시 (64-bit Windows 에서 handle 잘림 방지)
user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.argtypes = []
user32.CloseClipboard.restype = wintypes.BOOL
user32.EnumClipboardFormats.argtypes = [wintypes.UINT]
user32.EnumClipboardFormats.restype = wintypes.UINT
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.GetClipboardFormatNameW.argtypes = [
    wintypes.UINT, wintypes.LPWSTR, ctypes.c_int
]
user32.GetClipboardFormatNameW.restype = ctypes.c_int
user32.GetClipboardOwner.argtypes = []
user32.GetClipboardOwner.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

kernel32.GlobalSize.argtypes = [wintypes.HANDLE]
kernel32.GlobalSize.restype = ctypes.c_size_t
kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
kernel32.GlobalLock.restype = wintypes.LPVOID
kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
kernel32.GlobalUnlock.restype = wintypes.BOOL

STD_FORMATS = {
    1: "CF_TEXT", 2: "CF_BITMAP", 3: "CF_METAFILEPICT", 4: "CF_SYLK",
    5: "CF_DIF", 6: "CF_TIFF", 7: "CF_OEMTEXT", 8: "CF_DIB", 9: "CF_PALETTE",
    10: "CF_PENDATA", 11: "CF_RIFF", 12: "CF_WAVE", 13: "CF_UNICODETEXT",
    14: "CF_ENHMETAFILE", 15: "CF_HDROP", 16: "CF_LOCALE", 17: "CF_DIBV5",
    0x0080: "CF_OWNERDISPLAY", 0x0081: "CF_DSPTEXT",
    0x0082: "CF_DSPBITMAP", 0x0083: "CF_DSPMETAFILEPICT",
    0x008E: "CF_DSPENHMETAFILE",
}


def get_format_name(fmt: int) -> str:
    if fmt in STD_FORMATS:
        return STD_FORMATS[fmt]
    if fmt >= 0xC000:
        buf = ctypes.create_unicode_buffer(256)
        n = user32.GetClipboardFormatNameW(fmt, buf, 256)
        if n > 0:
            return buf.value
        err = ctypes.get_last_error()
        return f"<reg {fmt:#06x} name? err={err}>"
    return f"<unknown {fmt:#06x}>"


def get_owner_title() -> str:
    hwnd = user32.GetClipboardOwner()
    if not hwnd:
        return "(no owner)"
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value or f"(hwnd {hwnd!s})"


def dump_clipboard(out_lines: list[str]) -> None:
    if not user32.OpenClipboard(None):
        err = ctypes.get_last_error()
        out_lines.append(f"ERROR: OpenClipboard 실패 (err={err})")
        return
    try:
        owner = get_owner_title()
        out_lines.append(f"Clipboard owner: {owner!r}")

        formats: list[int] = []
        fmt = 0
        while True:
            fmt = user32.EnumClipboardFormats(fmt)
            if fmt == 0:
                err = ctypes.get_last_error()
                if err and err != 0:
                    out_lines.append(f"(enum end err={err})")
                break
            formats.append(fmt)

        out_lines.append(f"=== Clipboard formats ({len(formats)}) ===")
        for fmt in formats:
            try:
                name = get_format_name(fmt)
            except Exception:
                name = "<name exception>"
                out_lines.append(f"  EXC in name: {traceback.format_exc()}")
            try:
                handle = user32.GetClipboardData(fmt)
            except Exception:
                out_lines.append(f"  EXC in GetClipboardData {fmt:#x}: {traceback.format_exc()}")
                handle = None

            if not handle:
                err = ctypes.get_last_error()
                out_lines.append(
                    f"  {fmt:#06x}  {name:50s}  NO_HANDLE (err={err})"
                )
                continue
            try:
                size = kernel32.GlobalSize(handle)
            except Exception:
                size = -1
            try:
                ptr = kernel32.GlobalLock(handle)
            except Exception:
                ptr = None
            if not ptr:
                out_lines.append(f"  {fmt:#06x}  {name:50s}  size={size}  (lock fail)")
                continue
            try:
                data = ctypes.string_at(ptr, min(size, 512))
                out_lines.append(f"  {fmt:#06x}  {name:50s}  size={size}")
                if fmt in (1, 7):
                    try:
                        txt = data.split(b"\x00", 1)[0].decode("cp949", errors="replace")
                        out_lines.append(f"    TEXT(cp949): {txt[:300]!r}")
                    except Exception as e:
                        out_lines.append(f"    decode err: {e}")
                elif fmt == 13:
                    try:
                        txt = data.decode("utf-16le", errors="replace").split("\x00", 1)[0]
                        out_lines.append(f"    TEXT(utf16): {txt[:300]!r}")
                    except Exception as e:
                        out_lines.append(f"    decode err: {e}")
                else:
                    hexpart = data[:96].hex(" ")
                    asciipart = "".join(
                        chr(b) if 32 <= b < 127 else "."
                        for b in data[:96]
                    )
                    out_lines.append(f"    HEX:  {hexpart}")
                    out_lines.append(f"    ASC:  {asciipart}")
            finally:
                kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def main() -> int:
    print("=== EasyForm 클립보드 진단 ===")
    print("1. 이지폼으로 가서 명세서 더블클릭 → [물품내역 복사하기] 클릭")
    print("2. 여기로 돌아와 Enter ↩")
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        pass

    out_lines: list[str] = []
    out_lines.append("=== EasyForm 클립보드 진단 v2 ===")
    try:
        dump_clipboard(out_lines)
    except Exception:
        out_lines.append("UNEXPECTED EXCEPTION:")
        out_lines.append(traceback.format_exc())

    # 화면 + 파일 양쪽
    result = "\n".join(out_lines)
    print(result)
    dump_path = Path(r"C:\Users\USER\Desktop\hdsign\easyform-data\clipboard_dump.txt")
    dump_path.parent.mkdir(parents=True, exist_ok=True)
    dump_path.write_text(result, encoding="utf-8")
    print(f"\n저장됨: {dump_path}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
