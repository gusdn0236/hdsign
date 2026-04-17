import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { fetchGalleryImages, deleteImage } from "../../api/gallery";
import "./GalleryUpload.css";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

const CATEGORIES = {
  galva: {
    label: "갈바 간판류",
    subCategories: ["갈바 후광", "갈바 오사이", "갈바 캡", "일체형"],
  },
  stainless: {
    label: "스텐 간판류",
    subCategories: ["스텐 캡", "스텐 오사이", "스텐 후광", "골드 스텐"],
  },
  epoxy: {
    label: "에폭시 간판류",
    subCategories: ["갈바 에폭시", "스텐 에폭시"],
  },
  special: {
    label: "특수/기타 가공물",
    subCategories: ["아크릴", "포맥스", "고무 스카시", "시트 커팅"],
  },
};

const compressImage = (file) => {
  return new Promise((resolve) => {
    const MAX_WIDTH = 1920;
    const QUALITY = 0.8;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;
        if (width > MAX_WIDTH) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => resolve(new File([blob], file.name, { type: "image/jpeg" })),
          "image/jpeg",
          QUALITY
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
};

export default function GalleryUpload() {
  const { token, logout } = useAuth();
  const [activeCategory, setActiveCategory] = useState("galva");
  const [viewSubCategory, setViewSubCategory] = useState("전체");
  const [images, setImages] = useState([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [modalIndex, setModalIndex] = useState(null);
  const fileInputRef = useRef();
  const currentCat = CATEGORIES[activeCategory];

  useEffect(() => {
    loadImages();
    setViewSubCategory("전체");
    setPreviews([]);
  }, [activeCategory]);

  useEffect(() => {
    const handleKey = (e) => {
      if (modalIndex === null) return;
      if (e.key === "ArrowLeft") setModalIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setModalIndex((i) => Math.min(previews.length - 1, i + 1));
      if (e.key === "Escape") setModalIndex(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modalIndex, previews.length]);

  const loadImages = async () => {
    setLoadingImages(true);
    try {
      const res = await fetch(BASE_URL + "/api/gallery?category=" + activeCategory);
      const data = await res.json();
      setImages(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingImages(false);
    }
  };

  const [dragOver, setDragOver] = useState(false);

  const processFiles = (files) => {
    const newPreviews = files.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      category: activeCategory,
      subCategory: currentCat.subCategories[0],
    }));
    setPreviews((prev) => [...prev, ...newPreviews]);
    setFeedback(null);
  };

  const handleFileChange = (e) => {
    processFiles(Array.from(e.target.files));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) processFiles(files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleSubCategoryChange = (index, subCategory) => {
    setPreviews((prev) => prev.map((p, i) => (i === index ? { ...p, subCategory } : p)));
  };

  const handleCategoryChange = (index, category) => {
    setPreviews((prev) =>
      prev.map((p, i) =>
        i === index ? { ...p, category, subCategory: CATEGORIES[category].subCategories[0] } : p
      )
    );
  };

  const handleRemovePreview = (index) => {
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    if (modalIndex === index) setModalIndex(null);
    else if (modalIndex > index) setModalIndex((i) => i - 1);
  };

  const handleUpload = async () => {
    if (!previews.length) {
      setFeedback({ type: "error", msg: "업로드할 파일을 선택해주세요." });
      return;
    }
    setUploading(true);
    setFeedback({ type: "success", msg: "압축 및 업로드 중..." });
    try {
      const groups = {};
      for (const p of previews) {
        const key = p.category + "||" + p.subCategory;
        if (!groups[key]) groups[key] = [];
        groups[key].push(p.file);
      }
      for (const key of Object.keys(groups)) {
        const [category, subCategory] = key.split("||");
        const compressed = await Promise.all(groups[key].map(compressImage));
        const formData = new FormData();
        formData.append("category", category);
        formData.append("subCategory", subCategory);
        compressed.forEach((f) => formData.append("files", f));
        const res = await fetch(BASE_URL + "/api/gallery/upload", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: formData,
        });
        if (!res.ok) throw new Error("업로드 실패");
      }
      setFeedback({ type: "success", msg: `${previews.length}장 업로드 완료!` });
      setPreviews([]);
      setModalIndex(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadImages();
    } catch (err) {
      setFeedback({ type: "error", msg: err.message });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("이 이미지를 삭제하시겠습니까?")) return;
    try {
      await deleteImage(token, id);
      setImages((prev) => prev.filter((img) => img.id !== id));
    } catch (err) {
      alert(err.message);
    }
  };

  const filteredImages = viewSubCategory === "전체"
    ? images
    : images.filter((img) => img.subCategory === viewSubCategory);

  const modalItem = modalIndex !== null ? previews[modalIndex] : null;

  return (
    <div className="gallery-upload-page">
      <div className="upload-header">
        <h1>갤러리 이미지 관리</h1>
        <div className="header-actions">
          <Link to="/admin/notices" className="site-link">공지사항 관리</Link>
          <Link to="/Gallery/Galva" className="site-link">갤러리 보러가기</Link>
          <button className="logout-btn" onClick={logout}>로그아웃</button>
        </div>
      </div>

      <div className="category-tabs">
        {Object.entries(CATEGORIES).map(([key, val]) => (
          <button
            key={key}
            className={`category-tab ${activeCategory === key ? "active" : ""}`}
            onClick={() => setActiveCategory(key)}
          >{val.label}</button>
        ))}
      </div>

      <div className="upload-panel">
        <h2>이미지 업로드</h2>
        <div
          className={"drop-zone" + (dragOver ? " drag-over" : "")}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          <span className="drop-icon">🖼️</span>
          <p>사진을 여기에 끌어다 놓거나 클릭해서 선택하세요</p>
          <p className="drop-sub">여러 장 동시 선택 가능</p>
          <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleFileChange} style={{display: "none"}} />
        </div>
        <div className="upload-controls">
          {previews.length > 0 && (
            <button className="upload-submit-btn" onClick={handleUpload} disabled={uploading}>
              {uploading ? "업로드 중..." : `${previews.length}장 업로드`}
            </button>
          )}
        </div>

        {feedback && <div className={`upload-feedback ${feedback.type}`}>{feedback.msg}</div>}

        {previews.length > 0 && (
          <div className="preview-grid">
            {previews.map((p, i) => (
              <div key={i} className="preview-item">
                <img src={p.previewUrl} alt={p.file.name} onClick={() => setModalIndex(i)} />
                <button className="preview-remove" onClick={() => handleRemovePreview(i)}>✕</button>
                <div className="preview-selects">
                  <select value={p.category} onChange={(e) => handleCategoryChange(i, e.target.value)}>
                    {Object.entries(CATEGORIES).map(([key, val]) => (
                      <option key={key} value={key}>{val.label}</option>
                    ))}
                  </select>
                  <select value={p.subCategory} onChange={(e) => handleSubCategoryChange(i, e.target.value)}>
                    {CATEGORIES[p.category].subCategories.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <p className="preview-filename">{p.file.name}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalItem && (
        <div className="preview-modal" onClick={() => setModalIndex(null)}>
          <div className="preview-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModalIndex(null)}>✕</button>
            <button className="modal-nav modal-prev" onClick={() => setModalIndex((i) => Math.max(0, i - 1))} disabled={modalIndex === 0}>‹</button>
            <div className="preview-modal-body">
              <img src={modalItem.previewUrl} alt={modalItem.file.name} />
              <div className="preview-modal-info">
                <p className="modal-filename">{modalItem.file.name}</p>
                <p className="modal-counter">{modalIndex + 1} / {previews.length}</p>
                <div className="modal-selects">
                  <label>카테고리</label>
                  <select value={modalItem.category} onChange={(e) => handleCategoryChange(modalIndex, e.target.value)}>
                    {Object.entries(CATEGORIES).map(([key, val]) => (
                      <option key={key} value={key}>{val.label}</option>
                    ))}
                  </select>
                  <label>세부 분류</label>
                  <select value={modalItem.subCategory} onChange={(e) => handleSubCategoryChange(modalIndex, e.target.value)}>
                    {CATEGORIES[modalItem.category].subCategories.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="modal-nav-btns">
                  <button onClick={() => setModalIndex((i) => Math.max(0, i - 1))} disabled={modalIndex === 0} className="modal-nav-small">‹ 이전</button>
                  <button onClick={() => setModalIndex((i) => Math.min(previews.length - 1, i + 1))} disabled={modalIndex === previews.length - 1} className="modal-nav-small">다음 ›</button>
                </div>
                <div className="modal-actions">
                  <button className="preview-remove-btn" onClick={() => handleRemovePreview(modalIndex)}>이 사진 제거</button>
                  <button className="upload-submit-btn" onClick={handleUpload} disabled={uploading} style={{marginTop: 8, width: "100%"}}>
                    {uploading ? "업로드 중..." : `전체 ${previews.length}장 업로드`}
                  </button>
                </div>
              </div>
            </div>
            <button className="modal-nav modal-next" onClick={() => setModalIndex((i) => Math.min(previews.length - 1, i + 1))} disabled={modalIndex === previews.length - 1}>›</button>
          </div>
        </div>
      )}

      <div className="image-grid-section">
        <h2>
          등록된 이미지
          <select value={viewSubCategory} onChange={(e) => setViewSubCategory(e.target.value)}
            style={{ fontSize: 13, padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", marginLeft: 8 }}>
            <option value="전체">전체</option>
            {currentCat.subCategories.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </h2>
        {loadingImages ? (
          <p className="loading-message">이미지를 불러오는 중...</p>
        ) : filteredImages.length === 0 ? (
          <p className="empty-message">등록된 이미지가 없습니다.</p>
        ) : (
          <div className="image-grid">
            {filteredImages.map((img) => (
              <div key={img.id} className="image-item">
                <img src={img.imageUrl} alt={img.originalName} />
                <div className="image-overlay">
                  <span className="image-name">{img.subCategory}</span>
                  <button className="delete-btn" onClick={() => handleDelete(img.id)}>삭제</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}