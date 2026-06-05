#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
재점검 판정(match_verdicts.json) 을 R2 에 적용 — 틀린(mismatch) 사진을 삭제해서
단가찾아보기 검색 때 엉뚱한 작업지시서가 안 뜨게 한다.

기본: mismatch 만 삭제. --include-uncertain 주면 uncertain 도 삭제(보수적이라 기본 제외).
사진 키 = {prefix}{easyform스템}_{idx}.{png|jpg|jpeg} (업로드와 동일 규칙). 3확장자 모두 시도.

R2 자격증명은 환경변수에서만:
  R2_ENDPOINT  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET  R2_PREFIX(기본 autoquote/)

사용:
  python scripts/apply_match_verdicts.py --dry-run         # 삭제 목록만
  python scripts/apply_match_verdicts.py                   # 실제 삭제(mismatch)
"""
import argparse
import json
import os
import sys

VERDICTS = r"C:\Users\USER\Desktop\hdsign\auto-quote-data\learning\match_verdicts.json"
EXTS = ("png", "jpg", "jpeg")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verdicts", default=VERDICTS)
    ap.add_argument("--include-uncertain", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    data = json.load(open(args.verdicts, encoding="utf-8"))
    vs = data["verdicts"] if isinstance(data, dict) else data
    kill = {"mismatch"} | ({"uncertain"} if args.include_uncertain else set())
    targets = [v for v in vs if v.get("verdict") in kill]
    prefix = os.environ.get("R2_PREFIX", "autoquote/")
    if not prefix.endswith("/"):
        prefix += "/"

    keys = []
    for v in targets:
        stem = v["file"][:-5] if v["file"].endswith(".json") else v["file"]
        for ext in EXTS:
            keys.append("%s%s_%s.%s" % (prefix, stem, v["idx"], ext))
    print("삭제 대상 invoice %d건 (verdict in %s) → 키 후보 %d개"
          % (len(targets), sorted(kill), len(keys)))

    if args.dry_run:
        for k in keys[:20]:
            print("  ", k)
        print("  ... (dry-run, 삭제 안 함)")
        return

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        print("boto3 필요: pip install boto3")
        sys.exit(1)
    miss = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
            if not os.environ.get(k)]
    if miss:
        print("환경변수 누락:", ", ".join(miss))
        sys.exit(1)

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )
    # 존재하는 것만 삭제(확장자 3개 중 실제 올라간 1개). head 로 확인 후 delete.
    deleted = 0
    for k in keys:
        try:
            s3.head_object(Bucket=bucket, Key=k)
        except Exception:
            continue
        s3.delete_object(Bucket=bucket, Key=k)
        deleted += 1
    print("삭제 완료: %d개 → %s/%s (invoice %d건의 틀린 사진 제거됨)"
          % (deleted, bucket, prefix, len(targets)))


if __name__ == "__main__":
    main()
