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

async function submitClientForm(path, formData, token) {
    if (!token) {
        const error = new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
        error.status = 401;
        throw error;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message =
            res.status === 401 || res.status === 403
                ? '로그인이 만료되었습니다. 다시 로그인해 주세요.'
                : res.status === 413
                    ? '첨부 용량이 너무 큽니다. 파일 총 용량을 줄여주세요.'
                    : (err.message || '요청 처리에 실패했습니다.');
        const error = new Error(message);
        error.status = res.status;
        throw error;
    }

    return res.json();
}

export function submitOrderApi(formData, token) {
    return submitClientForm('/api/client/orders', formData, token);
}

export function submitQuoteApi(formData, token) {
    return submitClientForm('/api/client/orders/quote', formData, token);
}

export async function getOrdersApi(token) {
    if (!token) {
        const error = new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
        error.status = 401;
        throw error;
    }

    const res = await fetch(`${BASE_URL}/api/client/orders`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message =
            res.status === 401 || res.status === 403
                ? '로그인이 만료되었습니다. 다시 로그인해 주세요.'
                : (err.message || '조회에 실패했습니다.');
        const error = new Error(message);
        error.status = res.status;
        throw error;
    }

    return res.json();
}
