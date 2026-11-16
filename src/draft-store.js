// Draft holder (Durable Object), one small instance per Instantly email_id.
//
// Why: drafts used to live only in KV. KV can show an old value (or nothing) for up to a minute in
// other Cloudflare locations. The draft is written by the queue job in one location, while the Slack
// button click is handled in another, so a fresh card could say "This draft was not found".
// A Durable Object has one copy with strongly consistent storage: what the queue job saved is what
// the button click reads, immediately. Each method runs without interleaving, so "claim" and
// "swap" are safe locks (one webhook = one card, one click = one send).
//
// Records delete themselves after 7 days (alarm), the same lifetime the KV copies had.

import { DurableObject } from 'cloudflare:workers';

const TTL_MS = 7 * 24 * 3600 * 1000;

export class DraftStore extends DurableObject {
	async read() {
		return (await this.ctx.storage.get('rec')) || null;
	}

	async write(rec) {
		await this.ctx.storage.put('rec', rec);
		await this.#expireLater();
		return true;
	}

	// Save only if nothing is stored yet. Returns true when this call won.
	async claim(rec) {
		if (await this.ctx.storage.get('rec')) return false;
		await this.ctx.storage.put('rec', rec);
		await this.#expireLater();
		return true;
	}

	// Save only if the stored status is still `from`. Returns the stored record when it was not.
	async swap(from, rec) {
		const cur = await this.ctx.storage.get('rec');
		if (!cur || cur.status !== from) return { ok: false, current: cur || null };
		await this.ctx.storage.put('rec', rec);
		return { ok: true, current: rec };
	}

	async remove() {
		await this.ctx.storage.deleteAll();
		return true;
	}

	async alarm() {
		await this.ctx.storage.deleteAll();
	}

	async #expireLater() {
		if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
	}
}
