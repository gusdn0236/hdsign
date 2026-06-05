#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
재매칭으로 찾은 올바른 작업지시서 사진을 R2 에 올린다(rematch_map.json 기반).
- 교정분: 기존(틀린) 사진을 올바른 것으로 덮어씀
- 신규분: 미매칭이던 invoice 에 사진 추가
키 규칙 = {prefix}{easyform스템}_{idx}.{ext} (단가찾아보기 백엔드가 찾는 이름과 동일).

many-to-many(한 명세서에 여러 지시서)인 경우: 지금 백엔드는 invoice 당 사진 1장만 지원하므로
'가장 잘 맞는' 첫 사진만 메인(<stem>_<idx>.<ext>)으로 올리고, 추가 사진은 _2,_3.. 접미사로도
올려둔다(추후 백엔드가 다장 지원하면 바로 활용).

R2 자격증명은 환경변수에서만:
  R2_ENDPOINT  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET  R2_PREFIX(기본 autoquote/)

사용:
  python scripts/upload_rematch_to_r2.py --dry-run
  python scripts/upload_rematch_to_r2.py
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

DATA = r"C:\Users\USER\Desktop\hdsign\auto-quote-data"
MAP = os.path.join(DATA, "learning", "rematch_map.json")
PHOTOS = os.path.join(DATA, "work-order-photos-sorted")


def build():
    mp = json.load(open(MAP, encoding="utf-8"))
    prefix = os.environ.get("R2_PREFIX", "autoquote/")
    if not prefix.endswith("/"):
        prefix += "/"
    uploads = []  # (local, key, ct)
    n_inv = n_multi = 0
    for fl, by_idx in mp.items():
        stem = fl[:-5] if fl.endswith(".json") else fl
        for idx, photos in by_idx.items():
            n_inv += 1
            if len(photos) > 1:
                n_multi += 1
            for i, name in enumerate(photos):
                src = os.path.join(PHOTOS, name)
                if not os.path.exists(src):
                    continue
                ext = (os.path.splitext(name)[1].lower().lstrip(".")) or "png"
                ct = "image/png" if ext == "png" else "image/jpeg"
                suffix = "" if i == 0 else "_%d" % (i + 1)  # 메인 + 보조(_2,_3..)
                uploads.append((src, "%s%s_%s%s.%s" % (prefix, stem, idx, suffix, ext), ct))
    print("재매칭 invoice %d건(다장 %d) → 업로드 사진 %d장" % (n_inv, n_multi, len(uploads)))
    return uploads, prefix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    uploads, prefix = build()

    if args.dry_run:
        for lp, k, _ in uploads[:20]:
            print("  ", k, "<-", os.path.basename(lp))
        print("  ... (dry-run)")
        return

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        print("boto3 필요: pip install boto3"); sys.exit(1)
    miss = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
            if not os.environ.get(k)]
    if miss:
        print("환경변수 누락:", ", ".join(miss)); sys.exit(1)

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3", endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )

    def put(job):
        lp, key, ct = job
        s3.upload_file(lp, bucket, key, ExtraArgs={"ContentType": ct})
        return key

    done = err = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(put, j) for j in uploads]
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                fut.result(); done += 1
            except Exception as e:
                err += 1; print("  [실패]", e)
            if i % 100 == 0:
                print("  ...%d/%d" % (i, len(uploads)))
    print("완료: 업로드 %d · 실패 %d → %s/%s" % (done, err, bucket, prefix))


if __name__ == "__main__":
    main()
