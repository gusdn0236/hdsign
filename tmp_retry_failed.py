"""중복 email 로 실패한 2건 재시도 — email 제외하고 phone/contactName 만 갱신.

또한 어느 다른 거래처가 같은 이메일을 점유 중인지 함께 보고."""
from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign")
from tmp_apply_to_homepage import login, put_client, _api_call, API_BASE  # type: ignore

# 실패한 2건 (위 출력 기준)
FAILED = [
    {"id": 108, "phone": "010-8284-2506", "contactName": "김윤선", "email_in_use": "slove6589@nate.com"},
    {"id": 215, "phone": "010-9034-5809", "contactName": "",         "email_in_use": "3208431@naver.com"},
]


def main() -> int:
    token = login()
    # 현재 거래처 목록 다시 받아서 어느 client 가 해당 이메일 차지중인지 확인
    req = urllib.request.Request(
        f"{API_BASE}/api/admin/clients",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        clients = json.loads(resp.read().decode("utf-8"))
    by_email = {}
    for c in clients:
        e = (c.get("email") or "").strip().lower()
        if e:
            by_email.setdefault(e, []).append(c)

    for f in FAILED:
        email = f["email_in_use"].lower()
        owners = by_email.get(email, [])
        owners_desc = [f"id={c['id']} '{c['companyName']}' status={c['status']}" for c in owners]
        print(f"\n[id={f['id']}] 이메일 점유: {owners_desc or '없음'}")

        payload = {"phone": f["phone"]}
        if f["contactName"]:
            payload["contactName"] = f["contactName"]
        res = put_client(token, f["id"], payload)
        if res:
            print(f"  ✅ 재시도 성공 — phone/contactName 갱신 (email 은 스킵, 수동 정리 필요)")
        else:
            print(f"  ❌ 재시도 실패")
    return 0


if __name__ == "__main__":
    sys.exit(main())
