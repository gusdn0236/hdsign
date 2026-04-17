const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

export async function fetchGalleryImages(category) {
  const res = await fetch(`${BASE_URL}/api/gallery?category=${category}`);
  if (!res.ok) throw new Error("이미지 목록을 불러오지 못했습니다.");
  return res.json();
}

export async function uploadImages(token, formData) {
  const res = await fetch(`${BASE_URL}/api/gallery/upload`, {
    method: "POST",
    headers: authHeaders(token),
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "업로드에 실패했습니다.");
  }
  return res.json();
}

export async function deleteImage(token, imageId) {
  const res = await fetch(`${BASE_URL}/api/gallery/${imageId}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error("삭제에 실패했습니다.");
}