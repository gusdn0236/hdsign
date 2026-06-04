import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// 빌드 시점의 커밋/브랜치/시각을 굽는다. 배포가 라이브에 반영됐는지 한눈에 확인하는 용도:
//  - 브라우저: https://hdsigncraft.com/version.json
//  - 콘솔: 페이지 로드 시 [HD사인] build <sha> ... 한 줄 출력 (main.jsx)
//  - 명령: irm https://hdsigncraft.com/version.json
function gitInfo() {
    const run = (cmd) => {
        try {
            return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        } catch {
            return '';
        }
    };
    const commit = run('git rev-parse --short HEAD') || 'unknown';
    const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
    // ASCII 전용 KST 타임스탬프(로케일/인코딩 의존 없음): "2026-06-04 20:52:57 KST".
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const builtAt = kst.toISOString().replace('T', ' ').slice(0, 19) + ' KST';
    return { commit, branch, builtAt };
}

// version.json 을 dist 루트에 산출물로 굽는다(public/ 처럼 커밋되는 정적 파일이 아니라 빌드 결과물).
function emitVersionPlugin(info) {
    return {
        name: 'emit-version-json',
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'version.json',
                source: JSON.stringify(info, null, 2) + '\n',
            });
        },
    };
}

export default () => {
    const info = gitInfo();
    return {
        base: '/',
        plugins: [react(), emitVersionPlugin(info)],
        define: {
            'import.meta.env.VITE_BUILD_SHA': JSON.stringify(info.commit),
            'import.meta.env.VITE_BUILD_BRANCH': JSON.stringify(info.branch),
            'import.meta.env.VITE_BUILD_TIME': JSON.stringify(info.builtAt),
        },
    };
};
