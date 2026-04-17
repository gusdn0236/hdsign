const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export async function loginApi(username, password) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "로그인에 실패했습니다.");
  }

  return res.json();
}