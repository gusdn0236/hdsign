import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { fetchGalleryImages, uploadImages, deleteImage } from "../../api/gallery";
import "./GalleryUpload.css";

const CATEGORIES = {
  galva: {
    label: "갈바 간판류",
    subCategories: ["전체", "갈바 후광", "갈바 오사이", "갈바 캡", "일체형"],
  },
  stainless: {
    label: "스텐 간판류",
    subCategories: ["전체", "스텐 캡", "스텐 오사이", "스텐 후광", "골드 스텐"],
  },
  epoxy: {
    label: "에폭시 간판류",
    subCategories: ["전체", "갈바 에폭시", "스텐 에폭시"],
  },
  special: {
    label: "특수/기타 가공물",
    subCategories: ["전체", "아크릴", "포맥스", "고무 스카시", "시트 커팅"],
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
          (blob) => {
            const compressed = new File([blob], file.name, { type: "image/jpeg" });
            resolve(compressed);
          },
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
  const [subCategory, setSubCategory] = useState("전체");
  const [images, setImages] = useState([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [compressing, setCompressing] = useState(false);
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
      setFeedback({ type: "error", msg: "업로드할 파일을 선택해주세요." });
      return;
    }
    if (subCategory === "전체") {
      setFeedback({ type: "error", msg: "업로드할 세부 카테고리를 선택해주세요." });
      return;
    }
    setCompressing(true);
    setFeedback({ type: "success", msg: "이미지 압축 중..." });
    const compressed = await Promise.all(selectedFiles.map(compressImage));
    setCompressing(false);
    selectedFiles.forEach((f, i) => {
      console.log(`[${f.name}] 원본: ${(f.size / 1024).toFixed(1)}KB → 압축후: ${(compressed[i].size / 1024).toFixed(1)}KB`);
    });

    const formData = new FormData();
    formData.append("category", activeCategory);
    formData.append("subCategory", subCategory);
    compressed.forEach((file) => formData.append("files", file));
    setUploading(true);
    setFeedback({ type: "success", msg: "업로드 중..." });
    try {
      await uploadImages(token, formData);
      setFeedback({ type: "success", msg: `${selectedFiles.length}장의 이미지가 업로드됐습니다.` });
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
        <h1>갤러리 이미지 관리</h1>
        <div className="header-actions">
          <Link to="/admin/notices" className="site-link">공지사항 관리</Link>
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
            {currentCat.subCategories.filter(s => s !== "전체").map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <label className="file-input-label">
            <span>파일 선택</span>
            <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleFileChange} />
          </label>
          <button className="upload-submit-btn" onClick={handleUpload} disabled={uploading || compressing}>
            {compressing ? "압축 중..." : uploading ? "업로드 중..." : "업로드"}
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
                <img src={img.imageUrl} alt={img.originalName} />
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