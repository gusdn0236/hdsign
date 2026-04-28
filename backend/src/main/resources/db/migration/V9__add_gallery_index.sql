-- 갤러리 카테고리별 최신 정렬 조회(GalleryService.getImages) 가속.
-- 카테고리 한 곳에 수백 장이 쌓여도 풀스캔 없이 인덱스 + reverse scan 으로 응답.
CREATE INDEX idx_gallery_cat_created
    ON gallery_images (category, created_at);
