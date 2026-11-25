"""명세서 작성용(이지폼 전용 에이전트) exe 빌드 + 홈페이지 다운로드 폴더에 올릴 준비.

    python build_easyform_agent.py

1) 빌드 버전(YYYYMMDD-HHMM) 을 _agent_build.py 에 박는다 → 에이전트 /ping 이 이 값을 돌려줌
2) PyInstaller 로 dist_agent/hdsign_easyform_agent.exe 빌드
3) frontend/public/downloads/hdsign-easyform-agent.exe 로 복사 + easyform-agent-version.json 기록
   → 홈페이지가 켜진 에이전트 버전과 비교해 다르면 '업데이트 필요' 표시.
그 다음 frontend 에서 `npm run deploy` 하면 라이브 반영.
"""
from __future__ import annotations

import datetime
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DL = HERE.parent / "frontend" / "public" / "downloads"


def main() -> int:
    ver = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    (HERE / "_agent_build.py").write_text(
        f'# 자동 생성(build_easyform_agent.py) — 손으로 고치지 말 것\nBUILD_VERSION = "{ver}"\n',
        encoding="utf-8",
    )
    rc = subprocess.call(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--distpath", "dist_agent",
         "--workpath", "build_agent", "hdsign_easyform_agent.spec"],
        cwd=HERE,
    )
    if rc != 0:
        print(f"빌드 실패 rc={rc}")
        return rc
    DL.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "dist_agent" / "hdsign_easyform_agent.exe", DL / "hdsign-easyform-agent.exe")
    (DL / "easyform-agent-version.json").write_text(
        json.dumps({"version": ver}, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"OK version={ver} → {DL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
