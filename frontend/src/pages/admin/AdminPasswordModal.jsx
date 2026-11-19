import React, { useState } from 'react';
import { changeAdminPasswordApi } from '../../api/auth';

const MIN_LENGTH = 12;

/** 관리자 본인 비밀번호 변경 모달. 현재 비번 확인 + 새 비번 12자 이상 + 확인 입력 일치. */
const AdminPasswordModal = ({ token, onClose }) => {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        if (next.length < MIN_LENGTH) return setError(`새 비밀번호는 ${MIN_LENGTH}자 이상이어야 합니다.`);
        if (next !== confirm) return setError('새 비밀번호 확인이 일치하지 않습니다.');
        setSaving(true);
        try {
            await changeAdminPasswordApi(token, current, next);
            setDone(true);
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="admin-pw-backdrop" onClick={onClose}>
            <div className="admin-pw-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
                <h3>관리자 비밀번호 변경</h3>
                {done ? (
                    <>
                        <p className="admin-pw-ok">비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 쓰세요.</p>
                        <div className="admin-pw-actions">
                            <button type="button" className="admin-pw-primary" onClick={onClose}>닫기</button>
                        </div>
                    </>
                ) : (
                    <form onSubmit={submit}>
                        <label>현재 비밀번호
                            <input type="password" value={current} autoComplete="current-password"
                                   onChange={(e) => setCurrent(e.target.value)} autoFocus />
                        </label>
                        <label>새 비밀번호 ({MIN_LENGTH}자 이상)
                            <input type="password" value={next} autoComplete="new-password"
                                   onChange={(e) => setNext(e.target.value)} />
                        </label>
                        <label>새 비밀번호 확인
                            <input type="password" value={confirm} autoComplete="new-password"
                                   onChange={(e) => setConfirm(e.target.value)} />
                        </label>
                        {error && <p className="admin-pw-error">{error}</p>}
                        <div className="admin-pw-actions">
                            <button type="button" onClick={onClose}>취소</button>
                            <button type="submit" className="admin-pw-primary" disabled={saving}>
                                {saving ? '변경 중…' : '변경'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
};

export default AdminPasswordModal;
