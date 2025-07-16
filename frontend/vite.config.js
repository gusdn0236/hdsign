import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default ({mode}) => {
    return defineConfig({
        base: mode === 'production' ? '/hdsign/' : '/',
        plugins: [react()],
    });
};