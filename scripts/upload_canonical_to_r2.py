#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
정본(matches.json → invoice_links.json) 기준으로 작업지시서 사진을 R2 에 올린다.

왜 이 스크립트가 필요한가:
  2026-06-09 매칭 정본이 groups.json/verified_pairs.json → matches.json 체계로 바뀌면서
  옛 본업로더(upload_autoquote_to_r2.py)는 deprecated 된 groups.json 을 읽어 더는 못 돈다.
  그 결과 정본엔 매칭됐지만 R2 에 안 올라간 명세서가 ~1,800건 생겼다(2026/2024 다수).
  이 스크립트는 정본 invoice_links.json 만 읽어, 백엔드가 찾는 이름 그대로 누락분만 올린다.

올리는 키(백엔드 InvoiceEvidenceService 가 찾는 이름과 동일):
  <prefix><easyform스템>_<invoice_idx>.<ext>          메인(첫 사진)
  <prefix><easyform스템>_<invoice_idx>_2.<ext>, _3..   보조(many-to-many, 백엔드는 _6 까지 읽음)

--skip-existing 이면 head_object 로 이미 있는 키는 건너뛴다(이어올리기 = 누락분만 push).

R2 자격증명은 환경변수에서만(스크립트에 비밀 없음):
  R2_ENDPOINT  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET  R2_PREFIX(기본 autoquote/)

사용:
  python scripts/upload_canonical_to_r2.py --dry-run         # 목록만(자격증명 불필요)
  python scripts/upload_canonical_to_r2.py --skip-existing   # 누락분만 실제 업로드(권장)
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

DATA = r"C:\Users\USER\Desktop\hdsign\auto-quote-data"
LINKS = os.path.join(DATA, "learning", "invoice_links.json")
PHOTOS = os.path.join(DATA, "work-order-photos-sorted")

# 백엔드 loadPhotos 가 메인 + _2.._6 까지만 읽으므로 그 이상은 올려도 안 쓰임.
MAX_PHOTOS = 6


def build(links_path):
    """invoice_links.json({'easyform_YYYY_kind.json#idx': [photo, ...]}) → 업로드 잡 리스트."""
    links = json.load(open(links_path, encoding="utf-8"))
    prefix = os.environ.get("R2_PREFIX", "autoquote/")
    if not prefix.endswith("/"):
        prefix += "/"

    uploads = []  # (local_path, r2_key, content_type)
    n_inv = n_multi = n_missing = 0
    for key, photos in links.items():
        if "#" not in key or not photos:
            continue
        fl, idx = key.split("#", 1)
        stem = fl[:-5] if fl.endswith(".json") else fl
        n_inv += 1
        if len(photos) > 1:
            n_multi += 1
        for i, name in enumerate(photos[:MAX_PHOTOS]):
            src = os.path.join(PHOTOS, name)
            if not os.path.exists(src):
                n_missing += 1
                continue
            ext = (os.path.splitext(name)[1].lower().lstrip(".")) or "png"
            ct = "image/png" if ext == "png" else "image/jpeg"
            suffix = "" if i == 0 else "_%d" % (i + 1)  # 메인 + 보조(_2,_3..)
            uploads.append((src, "%s%s_%s%s.%s" % (prefix, stem, idx, suffix, ext), ct))

    print("정본 명세서 %d건(다장 %d) · 로컬없음 %d장 · 업로드대상 %d장"
          % (n_inv, n_multi, n_missing, len(uploads)))
    return uploads, prefix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--links", default=LINKS, help="정본 매핑(기본 invoice_links.json)")
    ap.add_argument("--dry-run", action="store_true", help="목록만 출력(업로드 안 함)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="이미 있는 키는 head_object 로 건너뜀(누락분만 push) — 권장")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    uploads, prefix = build(args.links)

    if args.dry_run:
        for lp, k, _ct in uploads[:25]:
            print("   ", k, "<-", os.path.basename(lp))
        if len(uploads) > 25:
            print("    ... 외 %d건 (dry-run, 업로드 안 함)" % (len(uploads) - 25))
        return

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        print("boto3 필요: pip install boto3")
        sys.exit(1)

    missing = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
               if not os.environ.get(k)]
    if missing:
        print("환경변수 누락:", ", ".join(missing))
        sys.exit(1)

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )

    def put(job):
        lp, key, ct = job
        if args.skip_existing:
            try:
                s3.head_object(Bucket=bucket, Key=key)
                return ("skip", key)
            except Exception:
                pass
        s3.upload_file(lp, bucket, key, ExtraArgs={"ContentType": ct})
        return ("put", key)

    done = skipped = errors = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(put, j): j for j in uploads}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                kind, _key = fut.result()
                if kind == "put":
                    done += 1
                else:
                    skipped += 1
            except Exception as e:
                errors += 1
                print("  [실패]", futs[fut][1], "-", e)
            if i % 200 == 0:
                print("  ...%d/%d (put=%d skip=%d err=%d)" % (i, len(uploads), done, skipped, errors))

    print("완료: 업로드 %d · 건너뜀 %d · 실패 %d → %s/%s" % (done, skipped, errors, bucket, prefix))


if __name__ == "__main__":
    main()
