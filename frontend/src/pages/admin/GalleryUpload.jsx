import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { fetchGalleryImages, uploadImages, deleteImage } from "../../api/gallery";
import "./GalleryUpload.css";

const CATEGORIES = {
  galva: { label: "용융아연도금", subCategories: ["전체", "시설물", "철구조물", "기타"] },
  stainless: { label: "스테인리스", subCategories: ["전체", "난간", "문주", "기타"] },
  epoxy: { label: "에폭시도장", subCategories: ["전체", "바닥", "벽면", "기타"] },
  special: { label: "특수도장", subCategories: ["전체", "방청", "방화", "기타"] },
};

export default function GalleryUpload() {
  const { token, logout } = useAuth();
  const [activeCategory, setActiveCategory] = useState("galva");
  const [subCategory, setSubCategory] = useState("전체");
  const [images, setImages] = useState([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const fileInputRef = useRef();
  const currentCat = CATEGORIES[activeCategory];
  const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

  useEffect(() => {
    loadImages();
    setSubCategory("전체");
  }, [activeCategory]);

  const loadImages = async () => {
    setLoadingImages(true);
    try {
      const data = await fetchGalleryImages(activeCategory);
      setImages(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingImages(false);
    }
  };

  const handleFileChange = (e) => {
    setSelectedFiles(Array.from(e.target.files));
    setFeedback(null);
  };

  const handleUpload = async () => {
    if (!selectedFiles.length) {
      setFeedback({ type: "error", msg: "업로드할 파일을 선택하세요." });
      return;
    }
    const formData = new FormData();
    formData.append("category", activeCategory);
    formData.append("subCategory", subCategory);
    selectedFiles.forEach((file) => formData.append("files", file));
    setUploading(true);
    setFeedback(null);
    try {
      await uploadImages(token, formData);
      setFeedback({ type: "success", msg: `${selectedFiles.length}개 이미지가 업로드되었습니다.` });
      setSelectedFiles([]);
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

  const filteredImages = subCategory === "전체"
    ? images
    : images.filter((img) => img.subCategory === subCategory);

  return (
    <div className="gallery-upload-page">
      <div className="upload-header">
        <h1>📁 갤러리 이미지 관리</h1>
        <div className="header-actions">
          <Link to="/" className="site-link">사이트 보기</Link>
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
        <h2>이미지 업로드 — {currentCat.label}</h2>
        <div className="upload-controls">
          <select value={subCategory} onChange={(e) => setSubCategory(e.target.value)}>
            {currentCat.subCategories.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <label className="file-input-label">
            <span>📷 파일 선택</span>
            <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleFileChange} />
          </label>
          <button className="upload-submit-btn" onClick={handleUpload} disabled={uploading}>
            {uploading ? "업로드 중..." : "업로드"}
          </button>
        </div>
        {selectedFiles.length > 0 && (
          <p className="selected-files">선택된 파일: {selectedFiles.map((f) => f.name).join(", ")}</p>
        )}
        {feedback && (
          <div className={`upload-feedback ${feedback.type}`}>{feedback.msg}</div>
        )}
      </div>

      <div className="image-grid-section">
        <h2>
          등록된 이미지
          <select value={subCategory} onChange={(e) => setSubCategory(e.target.value)}
            style={{ fontSize: 13, padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", marginLeft: 8 }}>
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
                <img src={`${BASE_URL}/uploads/${img.imageUrl}`} alt={img.originalName} />
                <div className="image-overlay">
                  <span className="image-name">{img.originalName}</span>
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