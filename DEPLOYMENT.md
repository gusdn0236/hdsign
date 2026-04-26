# Deployment

## Frontend

- Deploy target: GitHub Pages
- Live URL: `https://hdsigncraft.com`
- API base URL is set in [frontend/.env.production](/C:/Users/USER/Desktop/hdsign/frontend/.env.production)

Current production value:

```env
VITE_API_URL=https://hdsign-production.up.railway.app
VITE_GA_MEASUREMENT_ID=
VITE_GOOGLE_SITE_VERIFICATION=
VITE_NAVER_SITE_VERIFICATION=
```

Deploy command:

```powershell
cd frontend
npm.cmd run build
npm.cmd run deploy
```

## Backend

- Deploy target: Railway
- Service directory: `backend`
- Runtime: Java 17
- Docker build file: [backend/Dockerfile](/C:/Users/USER/Desktop/hdsign/backend/Dockerfile)

Recommended Railway settings:

1. Root Directory: `backend`
2. Builder: `Dockerfile`
3. Port: `8080`

Required environment variables:

```env
DB_URL=
DB_USERNAME=
DB_PASSWORD=
JWT_SECRET=
JWT_EXPIRATION_MS=43200000
JWT_CLIENT_EXPIRATION_MS=43200000
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_ENDPOINT=
R2_BUCKET=
R2_PUBLIC_URL=
RESEND_API_KEY=
RESEND_API_BASE_URL=https://api.resend.com
MAIL_FROM=HD Sign <onboarding@resend.dev>
ORDER_MAIL_TO=hdno0236@naver.com
MAGIC_LINK_BASE_URL=https://hdsigncraft.com
```

Reference example file:

- [backend/.env.example](/C:/Users/USER/Desktop/hdsign/backend/.env.example)

## Post-Deploy Check

1. Open `https://hdsign-production.up.railway.app/api/gallery`
2. Open `https://hdsigncraft.com`
3. Submit a client registration request
4. Approve it in `/admin/clients`
5. Confirm the email link opens `https://hdsigncraft.com/client/verify?...`
6. Confirm login succeeds and the client request page opens

## Notes

- Backend secrets must stay in Railway environment variables only.
- Resend free plan still requires a valid API key, and production sending should use a verified domain in `MAIL_FROM`.
- `MAGIC_LINK_BASE_URL` should match the deployed frontend URL.
- If Railway is connected to GitHub auto-deploy, pushing `master` redeploys the backend.
- Search Console verification token should be set in `VITE_GOOGLE_SITE_VERIFICATION`.
- Naver verification token should be set in `VITE_NAVER_SITE_VERIFICATION`.
- Google Analytics GA4 Measurement ID (for example `G-XXXXXXXXXX`) should be set in `VITE_GA_MEASUREMENT_ID`.
