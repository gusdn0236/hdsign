# 이지폼 명세서 + 톡 사진 → 웹 주기 업데이트 런북

매일/매주 신규 **명세서 상세** + **작업지시서 사진**을 증분으로 받아 매칭·웹 반영하는 절차.
**핵심 원칙: 이미 받은 것 다음부터만(증분).** 처음부터 다시 받지 않는다.

> 정본 추출 매크로 = `tenet-test/.tenet/learning/easyform_fast.py` (우클릭 복사 fast).
> ⚠ `hdsign/scripts/easyform_batch.py`(옛 Ctrl+C)는 2026 전자명세서 셀 오염 → **쓰지 말 것**.

---

## A. 명세서 상세 증분 추출

### A-1. 새 CSV 매출거래목록 export (이지폼에서)
이지폼 → 매출거래목록 → `[엑셀(csv)]` → 저장:
- 주식회사 → `hdsign/easyform-data/26년도매출거래목록(주식회사).csv` (덮어쓰기)
- 개인 → `hdsign/easyform-data/26년도매출거래목록(개인).csv` (덮어쓰기)

### A-2. 시작점 확인 (읽기전용 도우미)
```
py -3 hdsign/scripts/easyform_resume_plan.py
```
→ 종류별 **내릴 횟수 N**(raw 기준!) + 마지막 추출 명세서(날짜·거래처) + 실행명령 출력.
⚠ **N = raw(목록) 건수**, 폴더(enriched) 건수 아님. enrich 가 미발행 명세서를 떨궈서 폴더가 더 적다.
목록엔 미발행도 그대로 있으니 raw 만큼 내려야 첫 새 명세서에 선다.

### A-3. 목록에서 시작점까지 내리기
이지폼 [매출거래명세서 목록] · **'역순으로 보기' 끄기(정순)** · 1번째(가장 오래된) 행 클릭(Enter 금지).
```
py -3 hdsign/scripts/easyform_seek.py <N>      # ↓ N회 → N+1번째 활성
```
**검증**: 활성된 행 날짜가 도우미가 알려준 '마지막 추출' 날짜보다 **뒤**인지 눈으로 확인.

### A-4. 추출 (우클릭 복사 fast — raw 에 append)
N+1번째 행에서 **Enter 로 상세 열기** → 손 떼고:
```
py -3 tenet-test/.tenet/learning/easyform_fast.py --start <N> --out hdsign/easyform-data/easyform_2026_<corp|personal>_fast.json
```
- 새 명세서만 추출, **목록 끝(빈 8연속)에서 자동 정지**. Ctrl+Esc = 즉시 중단(받은 건 저장됨).
- 처음 한 번은 `--bench`(현재 1건만)로 좌표 유효 확인 권장. 창은 calibration 때와 같은 위치·최대화.

### A-5. 보강 (CSV 정렬 → enriched 최종, raw 보존)
```
py -3 hdsign/scripts/enrich_2026_aligned.py \
   --json hdsign/easyform-data/easyform_2026_<kind>_fast.json \
   --csv  hdsign/easyform-data/26년도매출거래목록(<주식회사|개인>).csv \
   --out  hdsign/auto-quote-data/invoices/easyform_2026_<kind>.json --save
```
- raw 는 **읽기만**(다음 append 위해 보존). enriched 최종만 갱신.
- invoice_idx 는 접두부가 동일하게 유지 → **기존 R2 사진키 보존**(새 명세서만 뒤에 idx 추가).
- 정확일치율 90% 미만이면 저장 중단(정렬 이상 → 점검).

---

## B. 톡 사진 증분 다운로드

도구 = `C:\kakao-dl\` (Playwright, talkcloud.kakao.com 사진모음 → zip-100 배치 다운로드).
**증분 자동**: `progress.json` 의 `seen`(받은 사진 ID 집합)을 기억해 **안 받은 것만** 받는다.

### ★ 사진모음을 '최신순(최신이 위)' 으로 정렬할 것
증분 조기정지 때문이다: 위(신규)부터 훑어 **이미 받은(boundary 이하/seen) 구간이 연속으로 나오면 멈춘다**
→ 전체 8천여장을 매번 안 훑어 빠름. `capture-dates.mjs`는 기존 `kakao_photo_dates.json` 의 최신 createdAt 을
boundary 로, `download.mjs` 는 `seen` 집합을 기준으로 조기정지(연속 무신규 40스텝).
- ⚠ **오래된순으로 두면** 위가 옛날거라 즉시 멈춰 **신규를 못 받는다**(silent miss). 반드시 최신순.
- 데이터 자체는 순서로 안 꼬임(① seen 스킵 ② createdAt 이름 ③ `_i_<hex>` dedup, 3중). 문제는 '멈추는 위치'뿐.
- **full 모드**(전체 스캔, 초기 다운로드/긴 공백/정렬 못 바꿀 때): `node capture-dates.mjs <out> full` · `node download.mjs 999 full`.

### ⚠ 필수: 일반 Chrome 아니라 **디버그 Chrome(포트 9222)**
download.mjs 는 `localhost:9222` CDP 로만 붙는다. 일반 Chrome 화면으론 동작 안 함.

### 실행 (원클릭 런처)
1. **`C:\kakao-dl\kakao-launch.bat`** 더블클릭 → 디버그 Chrome(전용 프로필) + talkcloud 열림.
   - 처음 1회만 카톡 **로그인**(프로필에 저장됨). 이지폼방 **사진모음 그리드** 열기.
2. **`C:\kakao-dl\run-update.bat`** 더블클릭 → ① 날짜맵 자동캡처(`capture-dates.mjs`, F12 대체)
   `C:\kakao-dl\kakao_photo_dates.json` ② 신규 사진만 다운로드 → `C:\kakao-eform\_zips\batch-*.zip`.
   - 첫 배치 로그 `selected N` 확인: N 이 작으면 정상(신규만), 수천이면 ID 변경(재스캔) — 그래도 ③ 내용 dedup 가 잡음.

### 마무리 (로컬, 신규분 정리)
```
# 1) 신규 batch zip 압축풀기 → work-order-photos\  (PowerShell)
Expand-Archive C:\kakao-eform\_zips\batch-*.zip -DestinationPath <repo>\auto-quote-data\work-order-photos\ -Force
# 2) 날짜이름으로 정리(+manifest)
py -3 <repo>\auto-quote-data\work-order-photos\_sort_by_date.py --map C:\kakao-dl\kakao_photo_dates.json
# 3) 같은 사진(_i_<hex>) 중복 정리
py -3 <repo>\auto-quote-data\work-order-photos-sorted\_dedup_samekey.py
```
- 결과: `auto-quote-data/work-order-photos-sorted/`(YYYY-MM-DD_…png) + `_manifest.csv` 갱신.
- 증분 경계 확인: `_manifest.csv` 의 최신 date 가 마지막 보유분(예: 2026-05-29) → 그 이후만 새로 들어옴.

---

## C. 사진 비전 추출 (신규 사진만)
신규 사진을 소넷 비전으로 구조화 추출(거래처/발주·출고일/자재/사이즈). 구독요금 API$0.
- 워크플로: `auto-quote-data/learning/resume_vision_extract.js` (청크 범위 args 로 신규분만)
- 병합 → `auto-quote-data/learning/photo_extractions.json`

## D. 매칭 (사진 ↔ 명세서, N:N) → 단일 정본 matches.json
```
py -3 hdsign/auto-quote-data/learning/match_photos_to_invoices_v4.py   # match_links/invoice_links 생성
py -3 hdsign/auto-quote-data/learning/build_matches.py                 # → matches.json (누적 정본)
```
- 매칭: 거래처+[발주~출고+7] 창, 품목코드·규격 게이트, 연도=명세서로 확정.
- **`matches.json` = 모든 매칭의 단일 정본**(사진↔명세서 링크 + 사진파일명·날짜·자재·점수·method).
  build_matches 는 기존 matches.json 을 씨앗으로 **누적**(과거 비전매칭 보존) + 신규 text-v4 추가.
  → 매출분석(명세서→사진파일명 연동), 단가찾아보기, 추후 개발 전부 이 파일 하나만 읽으면 됨.
- (구버전 match_map/match_all/rematch/verdicts 등은 `learning/_deprecated_*/` 로 아카이브됨.)

## E. 병합 + R2 업로드 (신규 증분만)
기존 매칭 유지 + 신규 (file,idx) 만 `photo_merge_new.json` 생성 → R2 업로드:
```
py -3 hdsign/scripts/upload_rematch_to_r2.py --map hdsign/auto-quote-data/learning/photo_merge_new.json
```
- ⚠ 단가찾아보기 가격검색은 `priced_index.json` 을 읽으므로, 명세서 갱신 시 **`build_learn_corpus.py` 로 재빌드 → R2 업로드** 필요. 매출분석은 R2 의 `easyform_*.json` 을 읽음 → 그것도 업로드.
- R2 env 필요: `R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET`.
- ⚠⚠ **R2 키가 대화/로그에 노출되면 교체(rotate)**. 키는 본인 PowerShell 창에서만 set.

## F. 배포
- 백엔드 변경 시: `git push` → Railway 자동배포.
- 프론트 변경 시: `cd frontend && npm run deploy` (gh-pages → hdsigncraft.com).
- 명세서/사진 데이터만 갱신(코드 무변경)이면 배포 불필요 — R2 가 즉시 반영.

---

## 빠른 체크리스트 (매 주기)
1. [ ] 이지폼에서 새 CSV 2개 export (A-1)
2. [ ] `easyform_resume_plan.py` 로 N 확인 (A-2)
3. [ ] corp: seek N → 상세 열기 → fast --start N → enrich (A-3~5)
4. [ ] personal: 동일
5. [ ] 톡 사진 증분 다운로드 (B)
6. [ ] 비전 추출(신규) → 매칭 → 병합 → R2 업로드 (C~E)
7. [ ] 필요시 배포 (F)
