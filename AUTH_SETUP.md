# Google Play authentication backend

This project does not use `auroraoss.com` as a default third-party backend.

Configure one of these Cloudflare Worker options:

1. Direct Google authentication (recommended for a private/self-hosted deployment): set Worker secrets `GOOGLE_ACCOUNT_EMAIL` and `GOOGLE_AAS_TOKEN`. Use a dedicated throwaway Google account. The AAS token must start with `aas_et/`.
2. Custom dispenser: set Worker variable `PLAY_DISPENSER_URL` to your own HTTPS Aurora-compatible dispenser endpoint.

The public frontend never receives either Cloudflare secret. `/api/health` only exposes the active mode (`direct-google`, `custom-dispenser`, or `unconfigured`).
