# -*- coding: utf-8 -*-
"""CSV 매출거래목록이 '새 것'인지(새 명세서가 들었는지) 점검 — 명세서 추출 런처용.
CSV 명세서 수 vs 현재 보강본(enriched) 수를 비교해 '새 명세서 약 N건' + 경고를 출력.
사용: py -3 easyform_csv_check.py <corp|personal> [year=2026]
"""
import sys, os, io, csv, json, datetime

kind = sys.argv[1] if len(sys.argv) > 1 else "corp"
year = sys.argv[2] if len(sys.argv) > 2 else "2026"
kor = "주식회사" if kind == "corp" else "개인"
yy = int(year) % 100
BASE = r"C:\Users\USER\Desktop\hdsign"
csvp = os.path.join(BASE, "easyform-data", "%d년도매출거래목록(%s).csv" % (yy, kor))
enrp = os.path.join(BASE, "auto-quote-data", "invoices", "easyform_%s_%s.json" % (year, kind))

if not os.path.isfile(csvp):
    print("*** 경고: CSV 파일이 없습니다 ***")
    print("   %s" % csvp)
    print("   이지폼 매출거래목록에서 [엑셀(csv)] 로 내보내 이 경로에 저장하세요.")
    sys.exit(0)

# CSV 명세서 수
try:
    rows = list(csv.reader(open(csvp, encoding="cp949")))
    hi = next((i for i, r in enumerate(rows) if r and r[0] == "사업자번호"), None)
    n_csv = sum(1 for r in rows[hi + 1:] if len(r) >= 11 and r[0].strip()) if hi is not None else 0
except Exception as e:
    print("CSV 읽기 오류:", e); sys.exit(0)

# 보강본 수
try:
    n_enr = len(json.load(io.open(enrp, encoding="utf-8")).get("invoices", []))
except Exception:
    n_enr = 0

mtime = datetime.datetime.fromtimestamp(os.path.getmtime(csvp)).strftime("%m-%d %H:%M")
new = n_csv - n_enr
print("CSV 명세서 %d건 (파일수정 %s)  /  현재 보강본 %d건  ->  새 명세서 약 %d건" % (n_csv, mtime, n_enr, new))
if new <= 0:
    print("")
    print("****************************************************************")
    print("  경고: CSV 에 새 명세서가 없습니다(새 것=0).")
    print("  이지폼에서 26년 %s 매출거래목록 CSV 를 '새로' export 했나요?" % kor)
    print("  안 했으면 이 창 닫고 -> 이지폼에서 새로 export -> 다시 실행하세요.")
    print("****************************************************************")
else:
    print("  -> 새 명세서 %d건 추출 예정. 진행하세요." % new)
