"""특정 폴더명이 xls 에 어떻게 들어가 있는지 진단."""
from __future__ import annotations
import re
import sys
import unicodedata
from pathlib import Path
import xlrd

XLS = Path(r"C:\Users\USER\Documents\카카오톡 받은 파일\거래처정보_20260430181444.xls")

# 진단 대상
TARGETS = [
    "AS광고", "RGB칼라", "TDX(강남)", "YKAD(채진창님)",
    "금보이테크", "금오광고", "나인산업(전주)", "남운",
    "데코디자인하우스(대전)", "두산종합광고", "디자인바움(성기술님)",
    "모아(광명)", "사답(김성미팀장님)", "순천새한광고",
    "시대사인", "싸인온", "아이앤지", "아이원인테리어",
    "애드참", "앤트디자인", "엔엔씨광고(전북)", "이미지광고(성남)",
    "제일광고(장부장님)", "준디자인", "태백기획(윤문걸님)",
    "팍스", "하우드유두", "한남광고토탈디자인",
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", str(s)).strip()
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[.\-_/]", "", s)
    return s.lower()


def main():
    book = xlrd.open_workbook(str(XLS))
    sh = book.sheet_by_index(0)
    header = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
    name_col = next(i for i, h in enumerate(header) if "상호" in h)

    rows = []
    for r in range(1, sh.nrows):
        rows.append([sh.cell_value(r, c) for c in range(sh.ncols)])

    for target in TARGETS:
        print(f"\n=== '{target}' ===")
        # 폴더명 핵심 토큰 추출 — 괄호 제거 후 첫 글자 묶음
        core = re.sub(r"[\(（].*?[\)）]", "", target).strip()
        n_target = norm(core)
        # 짧은 영문/한글 토큰 (예: AS, RGB, 남운, 팍스) 검색용
        short = re.sub(r"[\(（].*?[\)）]", "", target).strip()
        candidates = []
        for row in rows:
            xls_name = str(row[name_col]).strip()
            n_xls = norm(xls_name)
            # 매칭 후보: (1) 정확/포함, (2) 토큰 포함
            if n_target and (n_target in n_xls or n_xls in n_target):
                candidates.append(("substr", xls_name, row))
            elif short and short in xls_name:
                candidates.append(("raw", xls_name, row))
        # 중복 제거
        seen = set()
        uniq = []
        for tag, name, row in candidates:
            key = (tag, name)
            if key in seen:
                continue
            seen.add(key)
            uniq.append((tag, name, row))
        if not uniq:
            print("  (xls 에서 후보 없음)")
            continue
        for tag, xname, row in uniq[:8]:
            biz = str(row[1]).strip() if len(row) > 1 else ""
            owner = str(row[3]).strip() if len(row) > 3 else ""
            addr = str(row[4]).strip() if len(row) > 4 else ""
            print(f"  [{tag}] {xname}  | 사업자={biz} | 대표={owner} | 주소={addr[:30]}")


if __name__ == "__main__":
    main()
