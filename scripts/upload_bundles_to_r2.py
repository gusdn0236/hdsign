#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""묶음 정본 bundles.json 을 R2(비공개 autoquote 버킷)에 올린다.

build_bundles.py 산출 `auto-quote-data/learning/bundles.json` 을 백엔드가 찾는 키
`<prefix>bundles.json`(기본 autoquote/bundles.json) 으로 업로드. priced_index.json 과 동일한
JSON-에셋 업로드 패턴(upload_canonical_to_r2.py 와 같은 env 자격증명·content-type).

⚠ bundles.json 은 스냅샷이다 — matches.json 재생성 후 build_bundles.py 재실행 → 이 스크립트 재업로드.

R2 자격증명은 환경변수에서만:
  R2_ENDPOINT  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET  R2_PREFIX(기본 autoquote/)

사용:
  python scripts/upload_bundles_to_r2.py --dry-run     # 키만 출력(자격증명 불필요)
  python scripts/upload_bundles_to_r2.py               # 실제 업로드(항상 덮어씀 = 최신 스냅샷 반영)
"""
import argparse
import json
import os
import sys

DATA = r"C:\Users\USER\Desktop\hdsign\auto-quote-data"
SRC = os.path.join(DATA, "learning", "bundles.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC, help="업로드할 bundles.json 경로")
    ap.add_argument("--dry-run", action="store_true", help="키만 출력(업로드 안 함)")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print("없음:", args.src, "— 먼저 build_bundles.py 를 실행하세요.")
        sys.exit(1)

    prefix = os.environ.get("R2_PREFIX", "autoquote/")
    if not prefix.endswith("/"):
        prefix += "/"
    key = prefix + "bundles.json"

    # 요약(검증용): 묶음 수.
    try:
        n = len(json.load(open(args.src, encoding="utf-8")).get("by_invoice", {}))
        print("bundles.json 묶음 수: %d" % n)
    except Exception as e:
        print("[경고] bundles.json 파싱 실패:", e)

    if args.dry_run:
        print("  업로드 예정 키:", key, "<-", args.src)
        print("  ... (dry-run, 업로드 안 함)")
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
        "s3", endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )
    s3.upload_file(args.src, bucket, key, ExtraArgs={"ContentType": "application/json"})
    print("완료: 업로드 → %s/%s" % (bucket, key))


if __name__ == "__main__":
    main()
