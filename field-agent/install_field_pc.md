# 현장 PC 설치 가이드 (관리자용)

회사 가서 한 대씩 세팅할 때 그대로 따라하는 체크리스트.

## 1) 전제 조건

- Windows 10/11
- FlexiSIGN 설치돼 있고 `.fs` 더블클릭으로 정상 실행됨
- 사무실 네트워크 거래처 공유 폴더(`\\Main\공유\거래처` 등)에 이 PC 가 접근 가능
- Chrome 설치

## 2) 에이전트 배포

### A. 사전 빌드 (관리자 PC 에서 한 번)

```bat
cd field-agent
build.bat
```

→ `field-agent\dist\hdsign_field_agent.exe` 생성

### B. 현장 PC 에 복사

`hdsign_field_agent.exe` + `config.json` 두 파일을 한 폴더에 두기. 권장 위치:
`C:\Users\<사용자>\AppData\Local\HDSign\field-agent\`

### C. config.json 편집

`config.example.json` 을 복사해 `config.json` 으로 이름 바꾸고 환경값 수정:

```json
{
  "api_base": "https://hdsign-production.up.railway.app",
  "network_customer_base": "\\\\Main\\공유\\거래처",
  "flexisign_exe": "C:\\Program Files\\SAi\\Production Suite\\Cloud\\FlexiSign Pro\\FlexiSign.exe",
  "port": 17345,
  "allowed_origins": [
    "https://hdsigncraft.com",
    "https://www.hdsigncraft.com",
    "https://hdsign-production.up.railway.app",
    "https://hdsign.com",
    "https://www.hdsign.com"
  ],
  "fuzzy_threshold": 0.85
}
```

`flexisign_exe` 정확 경로 확인 방법: 시작메뉴 → FlexiSign 우클릭 → 파일 위치 열기 → 주소창에서 전체 경로 복사.

### D. 시작프로그램 등록

`Win+R` → `shell:startup` 입력 → 열린 폴더에 `hdsign_field_agent.exe` **바로가기**(Alt+드래그) 두기.

> 검증: PC 재부팅 → `http://127.0.0.1:17345/health` 가 `{"ok":true,"version":1}` 응답.

## 3) Chrome 사이드바 바로가기

바탕화면에 새 바로가기:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --app=https://hdsigncraft.com/field --window-size=420,1080 --window-position=1500,0
```

- `--window-size`/`--window-position` 은 본인 모니터 해상도에 맞춰 조정
- `--app=` 는 주소창 없는 단독창으로 띄움 → 사이드바처럼 보임

## 4) 첫 사용

1. 사이드바 창 열기 → 우상단 [담당] 클릭 → 본인 이름 선택
2. 작업할 지시서 카드의 [FS에서 열기] 클릭 → FlexiSIGN 자동 실행
3. 작업 끝나면 [완료] 버튼 → 사무실 작업현황에 본인 이름으로 완료 신호

## 5) 트러블슈팅

| 증상 | 해결 |
|---|---|
| [FS에서 열기] 누르면 "에이전트 연결 실패" 토스트 | 작업관리자 → `hdsign_field_agent.exe` 살아있는지 확인. 없으면 시작프로그램에서 다시 실행. |
| 토스트에 "거래처 폴더를 찾지 못했습니다" | 거래처관리(어드민) 의 `networkFolderName` 이 실제 폴더명과 다름. 어드민에서 정정 후 재시도. |
| 토스트에 "동일 stem 의 .fs 를 찾지 못했습니다" 후 폴더만 열림 | `.fs` 파일명이 .ai stem 과 너무 달라 매칭 실패. 폴더에서 수동 선택. 자주 발생하면 `fuzzy_threshold` 를 0.75 등으로 낮춰 자동 매칭 폭 넓히기. |
| 화면에 옛 데이터가 보임 | 사이드바 헤더의 [새로고침] 또는 사이드바 창 포커스 한 번 잃었다 다시 가져오면 자동 재조회. |
| 한 지시서에 [FS에서 열기] 가 회색 | 사무실 워처가 V12 마이그레이션 후 새로 인쇄해야 활성. 옛 업로드 건은 `originalPdfFilename` 컬럼이 비어있음. |
