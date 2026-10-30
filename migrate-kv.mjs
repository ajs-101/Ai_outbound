// Copies every key in the old HANDOFF_KV namespace (old Cloudflare account) into the new
// HANDOFF_KV namespace (new account), keeping each key's expiry. Uses your wrangler login,
// which must have access to BOTH accounts (check with: npx wrangler whoami).
// It only READS the old namespace; nothing there is changed or deleted.
//
// Usage (PowerShell, in the tpx-handoff folder):
//   node migrate-kv.mjs <OLD_ACCOUNT_ID> <OLD_KV_ID> <NEW_ACCOUNT_ID> <NEW_KV_ID>
// Add --missing-only to copy just the keys the new namespace does not have yet
// (never overwrites anything the new worker already wrote).

import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const missingOnly = process.argv.includes('--missing-only');
const [oldAcct, oldNs, newAcct, newNs] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!oldAcct || !oldNs || !newAcct || !newNs) {
	console.log('Usage: node migrate-kv.mjs <OLD_ACCOUNT_ID> <OLD_KV_ID> <NEW_ACCOUNT_ID> <NEW_KV_ID>');
	process.exit(1);
}
const isId = (x) => /^[0-9a-f]{32}$/i.test(x);
for (const [label, v] of [
	['old account ID', oldAcct],
	['old KV ID', oldNs],
	['new account ID', newAcct],
	['new KV ID', newNs],
]) {
	if (!isId(v)) {
		console.log(`The ${label} "${v}" is not a 32-character ID. Copy it from  npx wrangler whoami  (accounts) or the KV list.`);
		process.exit(1);
	}
}

// Use this project's wrangler through node itself (no shell), so folder names with spaces work.
const wranglerJs = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!existsSync(wranglerJs)) {
	console.log('Run this inside the tpx-handoff folder (node_modules/wrangler not found).');
	process.exit(1);
}
// Run from an empty folder so wrangler.jsonc does not pick the account.
const work = mkdtempSync(path.join(tmpdir(), 'tpx-kv-'));

function wrangler(args, account) {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[wranglerJs, ...args],
			{
				cwd: work,
				maxBuffer: 64 * 1024 * 1024,
				windowsHide: true,
				env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' },
			},
			(err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).slice(0, 400))) : resolve(stdout)),
		);
	});
}

// wrangler sometimes prints a banner before the output; keep only the real payload.
const stripBanner = (s) => String(s).replace(/^\s*⛅️?\s*wrangler[^\n]*\n[─-]+\n/, '');

console.log('Listing keys in the old namespace...');
const listRaw = stripBanner(await wrangler(['kv', 'key', 'list', '--namespace-id', oldNs, '--remote'], oldAcct));
const keys = JSON.parse(listRaw.slice(listRaw.indexOf('[')));
console.log(`${keys.length} keys found.`);

let existing = new Set();
if (missingOnly) {
	const newRaw = stripBanner(await wrangler(['kv', 'key', 'list', '--namespace-id', newNs, '--remote'], newAcct));
	existing = new Set(JSON.parse(newRaw.slice(newRaw.indexOf('['))).map((k) => k.name));
	console.log(`--missing-only: the new namespace already has ${existing.size} keys; those are left untouched.`);
}
const now = Math.floor(Date.now() / 1000);
const live = keys.filter((k) => (!k.expiration || k.expiration - now > 120) && !existing.has(k.name));
console.log(`${live.length} keys to copy.`);
const out = [];
let done = 0;
const queue = [...live];
async function worker() {
	while (queue.length) {
		const k = queue.shift();
		try {
			const value = stripBanner(await wrangler(['kv', 'key', 'get', k.name, '--namespace-id', oldNs, '--remote'], oldAcct)).replace(
				/\n$/,
				'',
			);
			out.push({ key: k.name, value, ...(k.expiration ? { expiration: k.expiration } : {}) });
		} catch (err) {
			console.log(`  could not read ${k.name}: ${err.message}`);
		}
		if (++done % 25 === 0) console.log(`  read ${done}/${live.length}`);
	}
}
await Promise.all(Array.from({ length: 6 }, worker));

// Reading takes minutes, so some keys may now be close to expiring. Cloudflare rejects an expiry
// less than 60 seconds away; drop anything with under 5 minutes left (it was about to vanish anyway).
const writeAt = Math.floor(Date.now() / 1000);
const expiring = out.filter((o) => o.expiration && o.expiration - writeAt < 300).length;
for (let i = out.length - 1; i >= 0; i--) if (out[i].expiration && out[i].expiration - writeAt < 300) out.splice(i, 1);
if (expiring) console.log(`  skipped ${expiring} keys that expire within 5 minutes`);

// Bulk write in chunks (wrangler accepts up to 10,000 per file; smaller chunks are safer).
for (let i = 0; i < out.length; i += 1000) {
	const file = path.join(work, `bulk-${i}.json`);
	writeFileSync(file, JSON.stringify(out.slice(i, i + 1000)));
	await wrangler(['kv', 'bulk', 'put', file, '--namespace-id', newNs, '--remote'], newAcct);
	console.log(`  wrote ${Math.min(i + 1000, out.length)}/${out.length}`);
}
rmSync(work, { recursive: true, force: true });

const count = (p) => out.filter((o) => o.key.startsWith(p)).length;
console.log(
	`\nDone. Copied ${out.length} keys (${existing.size ? `${keys.filter((k) => existing.has(k.name)).length} already in the new namespace, ` : ''}${keys.length - live.length - keys.filter((k) => existing.has(k.name)).length} about to expire).`,
);
console.log(`  Aimfox done markers: ${count('done:') + count('doneurl:')} · lead threads: ${count('lead:')} · drafts: ${count('draft:')}`);
console.log(
	`  PodPitch: ${count('ppthread:')} posted replies, watermark ${out.some((o) => o.key === 'pp:watermark') ? 'yes' : 'no'}, login token ${out.some((o) => o.key === 'pp:refresh') ? 'yes' : 'no'}`,
);
