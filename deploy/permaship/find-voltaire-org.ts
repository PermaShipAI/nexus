import 'dotenv/config';

const API_BASE = 'https://control.permaship.ai';
const API_KEY = process.env.PERMASHIP_API_KEY || '';

async function main() {
  // The API key might give us access to multiple orgs, or we can check
  // what org owns project 59b23537-...

  // Try listing all orgs accessible to this API key
  for (const path of ['/api/orgs', '/api/organizations', '/api/user/orgs']) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        headers: { 'Authorization': `ApiKey ${API_KEY}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log(`${path}: ${JSON.stringify(data).substring(0, 500)}`);
      } else {
        console.log(`${path}: ${resp.status}`);
      }
    } catch {
      console.log(`${path}: error`);
    }
  }

  // Try the project directly with no org context
  for (const path of [
    `/api/projects/59b23537-7989-4a3f-996b-4b93206ce19f`,
  ]) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        headers: { 'Authorization': `ApiKey ${API_KEY}` },
      });
      console.log(`${path}: ${resp.status} ${(await resp.text()).substring(0, 300)}`);
    } catch { /* ignored */ }
  }
}

main();
