// PodPitch login holder (Durable Object).
//
// Why: PodPitch replaces the refresh token on every refresh and rejects the old one. KV storage can
// show an old value for up to a minute in other locations, so two runs could refresh with the same
// token and PodPitch would cancel the login ("invalid_grant"). A Durable Object is one single
// instance with strongly consistent storage, and blockConcurrencyWhile lets only one refresh run at a
// time, so the newest token is always the one used.
//
// Seeded from the PODPITCH_OAUTH secret. After a new  node podpitch-login.mjs  +  secret put,
// it notices the secret changed and starts from the new login automatically.

export class PodpitchAuth {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		return this.state.blockConcurrencyWhile(async () => {
			try {
				if (!this.env.PODPITCH_OAUTH) return json({ error: 'PODPITCH_OAUTH secret is not set (run podpitch-login.mjs)' }, 500);
				const cfg = JSON.parse(this.env.PODPITCH_OAUTH);
				let s = (await this.state.storage.get('login')) || {};

				// New login saved in the secret -> start over from it.
				if (s.seed !== cfg.refresh_token || s.client_id !== cfg.client_id) {
					s = { seed: cfg.refresh_token, client_id: cfg.client_id, refresh: cfg.refresh_token };
				}
				if (url.searchParams.get('invalidate') === '1') {
					delete s.access;
					delete s.exp;
					await this.state.storage.put('login', s);
					return json({ ok: true });
				}
				if (s.access && s.exp - Date.now() > 60e3) return json({ token: s.access });

				const form = new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: s.refresh,
					client_id: cfg.client_id,
					resource: cfg.resource || 'https://api.podpitch.com/v1/mcp',
				});
				if (cfg.client_secret) form.set('client_secret', cfg.client_secret);
				const res = await fetch(cfg.token_endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
					body: form,
				});
				const t = await res.json().catch(() => ({}));
				if (!res.ok || !t.access_token) {
					s.last_error = `${res.status} ${JSON.stringify(t).slice(0, 150)}`;
					await this.state.storage.put('login', s);
					return json(
						{ error: `PodPitch login expired (${s.last_error}). Run podpitch-login.mjs again and update the PODPITCH_OAUTH secret.` },
						401,
					);
				}
				s.refresh = t.refresh_token || s.refresh; // keep the newest refresh token
				s.access = t.access_token;
				s.exp = Date.now() + (Number(t.expires_in) || 3600) * 1000;
				s.refreshed_at = new Date().toISOString();
				delete s.last_error;
				await this.state.storage.put('login', s);
				return json({ token: s.access });
			} catch (err) {
				return json({ error: `PodPitch login holder: ${err.message}` }, 500);
			}
		});
	}
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
