# HD사인 워처 (Illustrator → FlexiSIGN 자동화)

이 폴더는 워처 프로그램 한 덩어리를 자급자족으로 모아둔 곳이다.
새 채팅/다른 AI 와 작업할 때 **이 폴더 안만 보고 손봐도 된다.**

## 폴더 구조

```
hdsign-watcher/
├── README.md           ← 지금 이 문서
├── hdsign_watcher.py   ← 워처 본체 (Tkinter GUI + watchdog + Illustrator COM)
├── build.bat           ← PyInstaller 빌드 (dist/hdsign_worksheet.exe 생성)
├── run.bat             ← 소스 그대로 실행 (.py 직접 — 디버깅용)
├── install_deps.bat    ← pip 의존성 설치 (watchdog, qrcode, Pillow, pywin32, pymupdf, pyzbar)
├── assets/
│   └── distribution.jpg  ← 분배함 사진 (다이얼로그에서 칸 클릭용)
├── sumatra/            ← SumatraPDF 포터블 (인쇄 PDF 미리보기 — git 무시)
└── dist/
    └── hdsign_worksheet.exe  ← 빌드 산출물 (git 무시, 100MB+)
```

## 일상 사용

| 하고 싶은 일 | 더블클릭할 파일 |
|---|---|
| 워처 새로 빌드 | `build.bat` |
| 의존성만 설치 | `install_deps.bat` |
| 소스 바로 실행 (디버깅) | `run.bat` |
| 빌드된 워처 실행 | `dist\hdsign_worksheet.exe` |

## 빌드 동작 요약 (`build.bat`)

1. 떠있는 `hdsign_worksheet.exe` 자동 taskkill
2. 기존 exe 삭제 (안되면 rename 폴백)
3. `pyinstaller --onefile --windowed` 로 `assets\distribution.jpg` 번들 + `pymupdf`/`pyzbar` 네이티브 DLL 포함
4. 결과: `dist\hdsign_worksheet.exe` 새로 생성 (~100MB)

빌드 막히면 보통 워처가 관리자 권한으로 떠있어 잠긴 경우 — 작업관리자에서 강제 종료
또는 `build.bat` 자체를 관리자 권한으로 실행.

## 외부 의존

- **Python 3.9** — `C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe`
  (경로 다르면 `build.bat`/`install_deps.bat`/`run.bat` 안의 `PYTHON=` 줄 수정)
- **FlexiSIGN 6.6** — `C:\Users\USER\Desktop\FlexiSIGN 6.6\Program\App.exe`
  (경로 다르면 워처 소스의 `FLEXSIGN_EXE` 상수 수정)
- **Adobe Illustrator** — COM 자동화로 .ai → v8 변환

## 워처가 읽고 쓰는 외부 폴더

- `~/Downloads`, `C:\Users\USER\Desktop\hdsign_orders` — ZIP 감지 대상
- `C:\Users\USER\Desktop\hdsign_orders\state\` — 영속 상태 (config.json, recent_orders.json 등)
- `network_customer_base` (config.json) — 네트워크 거래처 폴더 (예: `Z:/거래처`)

## 외부 시스템

- 백엔드: `https://hdsigncraft.com` — 폴더 동기화, 인쇄 PDF 업로드, QR 증거사진 베이스
- QR 링크: `https://hdsigncraft.com/p/{orderNumber}` — 작업자가 모바일에서 사진 업로드

## 빌드 산출물 배포

빌드된 `dist\hdsign_worksheet.exe` 는 GitHub 에 못 올라간다 (100MB 한도 초과).
사무실 배포는 별도 공유폴더 / USB / `HD사인_프로그램_배포.zip` 등으로 전달.

## 다른 AI 와 작업할 때

> "이 hdsign-watcher 폴더 안만 보고 작업해줘. README 부터 읽고."

라고 던지면 한 폴더로 가둘 수 있다.
