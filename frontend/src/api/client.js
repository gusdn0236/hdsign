const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

export async function clientLoginApi(username, password) {
    const res = await fetch(`${BASE_URL}/api/client/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || '로그인에 실패했습니다.');
    }
    return res.json();
}

export async function submitOrderApi(formData, token) {
    if (!token) {
        const e = new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
        e.status = 401;
        throw e;
    }

    const res = await fetch(`${BASE_URL}/api/client/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message =
            res.status === 401 || res.status === 403
                ? '로그인이 만료되었습니다. 다시 로그인해주세요.'
                : res.status === 413
                    ? '첨부 용량이 너무 큽니다. 파일 총 용량을 줄여주세요.'
                : (err.message || '접수에 실패했습니다.');
        const e = new Error(message);
        e.status = res.status;
        throw e;
    }
    return res.json();
}

export async function getOrdersApi(token) {
    if (!token) {
        const e = new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
        e.status = 401;
        throw e;
    }

    const res = await fetch(`${BASE_URL}/api/client/orders`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message =
            res.status === 401 || res.status === 403
                ? '로그인이 만료되었습니다. 다시 로그인해주세요.'
                : (err.message || '조회에 실패했습니다.');
        const e = new Error(message);
        e.status = res.status;
        throw e;
    }
    return res.json();
}
