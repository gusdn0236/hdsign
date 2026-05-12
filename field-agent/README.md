# HD사인 현장 작업뷰어 — 로컬 에이전트

웹 사이드바(`/field`) 의 [FS에서 열기] 버튼이 호출하는 127.0.0.1 HTTP 리스너.
주문번호를 받아 백엔드에서 거래처 네트워크폴더명 + 원본 PDF 파일명을 조회하고,
거래처 폴더 트리를 워킹해 동일 stem 의 `.fs` 파일을 찾아 FlexiSIGN 으로 실행한다.

## 사무실 워처와의 차이

| | 사무실 워처(hdsign-watcher) | 현장 에이전트(field-agent) |
|---|---|---|
| 목적 | 자동 지시서 작성 — `.ai` 변환·QR 삽입·서버 업로드 | 작업자가 [FS에서 열기] 누르면 그 .fs 를 FlexiSIGN 으로 실행 |
| 의존성 | Illustrator COM, watchdog, OpenCV, PyMuPDF 등 다량 | 표준 라이브러리만 |
| UI | Tkinter 풀 GUI(분배함, 로그뷰어 등) | 콘솔 — 추후 트레이 아이콘으로 확장 |
| 실행 | 사무실 PC 에 1대 | 현장 PC 마다 1대 |

## 첫 실행

```bat
run.bat
```

처음 실행하면 옆에 `config.json` 이 생성된다. 다음 키들을 환경에 맞게 수정:

- `api_base` — 백엔드 베이스 URL (운영: `https://hdsign-production.up.railway.app`)
- `network_customer_base` — 사무실 네트워크 거래처 폴더 베이스 (워처와 동일 경로)
- `flexisign_exe` — FlexiSIGN 실행파일 절대경로. **보통 비워둔다(`""`)** — 비어 있거나 경로가 없으면 자동 탐지(레지스트리의 `.fs` 연결 프로그램 → `Program Files\SAi\**` 글롭 → 그래도 없으면 `.fs` 기본 연결로 열기). PC마다 설치 위치가 달라도 그냥 둬도 됨. 강제로 특정 PC만 다른 경로를 쓰게 하려면 그 PC의 `%LOCALAPPDATA%\HDSignFieldViewer\config.local.json` 에 `{"flexisign_exe": "D:\\...\\App.exe"}` 한 줄을 두면 공유 `config.json` 위에 덮어쓴다.
- `port` — 충돌 시만 변경. 변경 시 프론트 환경변수 `VITE_HDSIGN_AGENT_URL` 도 같이.
- `allowed_origins` — 호출 허용 도메인. 운영 도메인 + 로컬 개발(`http://localhost:5173`) 권장.
- `fuzzy_threshold` — `.fs` 이름이 미세하게 변형됐을 때 자동 매칭 임계값(0~1, 권장 0.85).

## 매칭 알고리즘

웹에서 [FS에서 열기] 클릭 → 에이전트가:

1. 백엔드에서 `networkFolderName` + `originalPdfFilename` 조회
2. `<network_customer_base>` 안에서 거래처 폴더 결정 — 1순위 `networkFolderName`, 2순위 `companyName`
3. 거래처 폴더를 재귀 탐색해 `.fs` 찾기:
   - **정확 매칭** — `<pdf_stem>.fs` 그대로 (대다수)
   - **유사 매칭** — stem 정규화 후 SequenceMatcher 유사도 ≥ `fuzzy_threshold`, 단일 후보일 때만
   - **실패** — 거래처 폴더 자체를 탐색기로 열고 웹에 "수동 선택" 토스트
4. 매칭 .fs 를 FlexiSIGN subprocess 로 실행

## 보안

- `127.0.0.1` 바인딩 — 동일 PC 안에서만 접근(LAN 의 다른 PC 호출 불가)
- POST + `X-HDSign-Field: 1` 커스텀 헤더 + CORS Origin 화이트리스트 → 다른 사이트가 fetch 로 임의 호출 불가능
- 권한 격상 없음 — 이미 사용자가 수동으로 열 수 있는 `.fs` 만 connector 로 실행

## 배포(예정 — Task 5)

PyInstaller `--onefile --noconsole` 로 단일 `.exe` 패키징 + 시작프로그램 폴더 바로가기.
