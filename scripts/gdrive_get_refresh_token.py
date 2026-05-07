"""
Google Drive refresh token 획득 스크립트 (일회성).

실행 방법:
    pip install google-auth-oauthlib
    python gdrive_get_refresh_token.py path\to\client_secret.json

흐름:
    1) 브라우저 자동으로 열림 → 공용 구글 계정으로 로그인
    2) "이 앱이 검증되지 않음" 경고가 떠도 [고급] → [HDSign Backup으로 이동(안전하지 않음)]
       (Google Cloud Console 의 Test users 에 등록된 계정만 가능 — 정상)
    3) Drive 권한 허용
    4) 콘솔에 client_id / client_secret / refresh_token 출력
       → Railway 의 환경변수 GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN 에 등록

스코프:
    drive.file — 이 앱이 만든 파일/폴더만 접근. 사용자의 다른 드라이브 자료는 못 봄.
"""
import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def main() -> int:
    if len(sys.argv) != 2:
        print("사용법: python gdrive_get_refresh_token.py <client_secret.json 경로>")
        return 1

    secret_path = sys.argv[1]
    flow = InstalledAppFlow.from_client_secrets_file(secret_path, SCOPES)
    # access_type=offline + prompt=consent 둘 다 줘야 refresh_token 이 무조건 발급됨.
    # (이미 동의한 계정이면 refresh_token 이 빠질 수 있어 강제로 재발급)
    creds = flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
        authorization_prompt_message="브라우저에서 공용 구글 계정으로 로그인해주세요. URL: {url}",
        success_message="인증 완료. 브라우저를 닫아도 됩니다.",
    )

    if not creds.refresh_token:
        print("refresh_token 이 발급되지 않았습니다. 위 흐름을 다시 시도해주세요.")
        return 2

    with open(secret_path, "r", encoding="utf-8") as f:
        secret = json.load(f)
    installed = secret.get("installed") or secret.get("web") or {}
    client_id = installed.get("client_id", "")
    client_secret = installed.get("client_secret", "")

    print()
    print("=" * 70)
    print("Railway 환경변수에 아래 값을 그대로 등록하세요 (Settings → Variables):")
    print("=" * 70)
    print(f"GDRIVE_CLIENT_ID={client_id}")
    print(f"GDRIVE_CLIENT_SECRET={client_secret}")
    print(f"GDRIVE_REFRESH_TOKEN={creds.refresh_token}")
    print("GDRIVE_ENABLED=true")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
