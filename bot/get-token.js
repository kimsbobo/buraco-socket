require('dotenv').config({ path: __dirname + '/.env' });

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/api')) return trimmed;
  return `${trimmed}/api`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = normalizeBaseUrl(args['backend-url'] || process.env.BOT_BACKEND_URL);
  const email = args.email || process.env.BOT_LOGIN_EMAIL;
  const password = args.password || process.env.BOT_LOGIN_PASSWORD;

  if (!baseUrl) {
    throw new Error('Missing backend URL. Set BOT_BACKEND_URL in bot/.env or pass --backend-url');
  }

  if (!email || !password) {
    throw new Error('Missing credentials. Set BOT_LOGIN_EMAIL and BOT_LOGIN_PASSWORD in bot/.env or pass --email/--password');
  }

  const loginUrl = `${baseUrl}/login`;

  console.log(`[TOKEN] Requesting token from ${loginUrl}`);

  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const detail = data ? JSON.stringify(data, null, 2) : response.statusText;
    throw new Error(`Login failed (${response.status}): ${detail}`);
  }

  console.log('\n=== FULL RESPONSE ===');
  console.log(JSON.stringify(data, null, 2));

  if (data?.access_token) {
    console.log('\n=== ACCESS TOKEN ===');
    console.log(data.access_token);
  }

  if (data?.refresh_token) {
    console.log('\n=== REFRESH TOKEN ===');
    console.log(data.refresh_token);
  }
}

main().catch((error) => {
  console.error(`[TOKEN] ${error.message}`);
  process.exit(1);
});
