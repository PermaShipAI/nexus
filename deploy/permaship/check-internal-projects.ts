import 'dotenv/config';

const API_BASE = 'https://control.permaship.ai';
const API_KEY = process.env.PERMASHIP_API_KEY || '';
const INTERNAL_SECRET = process.env.PERMASHIP_INTERNAL_SECRET || '';
const ORG_ID = '6febad35-dcd1-4076-91b7-de93e6e9f6d6';

async function tryEndpoint(label: string, url: string, headers: Record<string, string>) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    console.log(`Status: ${resp.status}`);
    if (resp.ok) {
      const data = JSON.parse(text);
      const projects = data.projects || data.data || (Array.isArray(data) ? data : []);
      console.log(`Projects (${projects.length}):`);
      for (const p of projects) {
        console.log(`  ${p.id} — ${p.name} (${p.slug})`);
      }
      return projects;
    } else {
      console.log(`Response: ${text.substring(0, 200)}`);
      return [];
    }
  } catch (err) {
    console.log(`Error: ${err}`);
    return [];
  }
}

async function main() {
  // Public API
  await tryEndpoint(
    'Public API (ApiKey)',
    `${API_BASE}/api/orgs/${ORG_ID}/projects`,
    { 'Content-Type': 'application/json', 'Authorization': `ApiKey ${API_KEY}` },
  );

  // Internal API
  await tryEndpoint(
    'Internal API (X-Internal-Secret)',
    `${API_BASE}/api/internal/orgs/${ORG_ID}/projects`,
    { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
  );

  // Try fetching the specific Voltaire project directly
  console.log('\n--- Direct project fetch (59b23537-...) ---');
  const projUrl = `${API_BASE}/api/orgs/${ORG_ID}/projects/59b23537-7989-4a3f-996b-4b93206ce19f`;
  for (const [label, headers] of [
    ['ApiKey', { 'Content-Type': 'application/json', 'Authorization': `ApiKey ${API_KEY}` }],
    ['Internal', { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET }],
  ] as const) {
    try {
      const resp = await fetch(projUrl, { headers });
      const text = await resp.text();
      console.log(`${label}: ${resp.status} ${text.substring(0, 300)}`);
    } catch (err) {
      console.log(`${label}: Error ${err}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
