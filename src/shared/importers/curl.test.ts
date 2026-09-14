import { describe, expect, it } from 'vitest';
import { CurlParseError, isCurlCommand, parseCurl } from './curl';
import { splitShellWords, tokenizeCmd } from './shellwords';

type Parsed = ReturnType<typeof parseCurl>;

describe('isCurlCommand', () => {
  it.each([
    ['curl https://example.com', true],
    ['  curl https://example.com  ', true],
    ['$ curl https://example.com', true],
    ['curl\nhttps://example.com', true],
    ['curl', true],
    ['curl.exe -H "a: b" https://x', true],
    ['curly https://example.com', false],
    ['wget https://example.com', false],
    ['https://example.com', false],
    ['echo curl', false],
    ['', false],
  ])('%j -> %s', (input, expected) => {
    expect(isCurlCommand(input)).toBe(expected);
  });
});

describe('shellwords', () => {
  it.each<[string, string[]]>([
    [`a 'b c' "d e"`, ['a', 'b c', 'd e']],
    [`"x\\"y\\\\z\\$w\\n"`, ['x"y\\z$w\\n']],
    [`'it'\\''s'`, ["it's"]],
    [`$'a\\nb\\t\\'c\\\\'`, ["a\nb\t'c\\"]],
    [`$'\\x41\\u00e9\\041\\xe2\\x80\\x99'`, ['Aé!’']],
    ['a\\ b c\\\nd', ['a b', 'cd']],
    ['one \\\n  two', ['one', 'two']],
    ['one `\n  two', ['one', 'two']],
    [`-H'X: y'`, ['-HX: y']],
    ['a b | jq .', ['a', 'b']],
  ])('%j', (input, expected) => {
    expect(splitShellWords(input)).toEqual(expected);
  });

  it('cmd tokenizer handles ^ escapes and msvcrt quoting', () => {
    expect(tokenizeCmd('curl ^"a^%^20b^" ^\n  -d ^"^{^\\^"k^\\^":1^}^"').map((t) => t.value)).toEqual([
      'curl',
      'a%20b',
      '-d',
      '{"k":1}',
    ]);
  });
});

const inherit = { type: 'inherit' } as const;

const cases: { name: string; input: string; expected: Parsed }[] = [
  {
    name: 'Chrome DevTools "Copy as cURL (bash)"',
    input: `curl 'https://api.github.com/repos/foo/bar/issues?state=open&per_page=10' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer fake_token_123' \\
  -H 'content-type: application/json' \\
  -H 'origin: https://github.com' \\
  -H 'sec-ch-ua: "Chromium";v="128", "Not;A=Brand";v="24"' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' \\
  --data-raw '{"title":"Bug","labels":["a","b"]}' \\
  --compressed`,
    expected: {
      name: 'POST /repos/foo/bar/issues',
      method: 'POST',
      url: 'https://api.github.com/repos/foo/bar/issues',
      params: [
        { key: 'state', value: 'open' },
        { key: 'per_page', value: '10' },
      ],
      headers: [
        { key: 'accept', value: 'application/json' },
        { key: 'accept-language', value: 'en-US,en;q=0.9' },
        { key: 'origin', value: 'https://github.com' },
        { key: 'sec-ch-ua', value: '"Chromium";v="128", "Not;A=Brand";v="24"' },
        { key: 'user-agent', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      ],
      auth: { type: 'bearer', token: 'fake_token_123' },
      body: { type: 'json', content: '{\n  "title": "Bug",\n  "labels": [\n    "a",\n    "b"\n  ]\n}' },
    },
  },
  {
    name: "Chrome bash copy with $'...' body containing escapes",
    input: `curl 'https://example.com/notes' \\
  -H 'content-type: application/json' \\
  --data-raw $'{"note":"it\\'s\\\\nfine","emoji":"caf\\u00e9"}'`,
    expected: {
      name: 'POST /notes',
      method: 'POST',
      url: 'https://example.com/notes',
      params: [],
      headers: [],
      auth: inherit,
      body: { type: 'json', content: '{\n  "note": "it\'s\\nfine",\n  "emoji": "café"\n}' },
    },
  },
  {
    name: 'Chrome DevTools "Copy as cURL (cmd)"',
    input: `curl ^"https://example.com/api/items?q=a^%^20b^" ^
  -H ^"accept: */*^" ^
  -H ^"content-type: application/json^" ^
  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"128^\\^"^" ^
  --data-raw ^"^{^\\^"name^\\^":^\\^"Widget^\\^",^\\^"qty^\\^":2^}^" ^
  --compressed`,
    expected: {
      name: 'POST /api/items',
      method: 'POST',
      url: 'https://example.com/api/items',
      params: [{ key: 'q', value: 'a b' }],
      headers: [
        { key: 'accept', value: '*/*' },
        { key: 'sec-ch-ua', value: '"Chromium";v="128"' },
      ],
      auth: inherit,
      body: { type: 'json', content: '{\n  "name": "Widget",\n  "qty": 2\n}' },
    },
  },
  {
    name: 'older Chrome cmd copy with plain double quotes',
    input: `curl "https://example.com/v2/x" ^
  -X "PUT" ^
  -H "Content-Type: text/plain" ^
  --data-raw "say \\"hi\\""`,
    expected: {
      name: 'PUT /v2/x',
      method: 'PUT',
      url: 'https://example.com/v2/x',
      params: [],
      headers: [{ key: 'Content-Type', value: 'text/plain' }],
      auth: inherit,
      body: { type: 'raw', content: 'say "hi"' },
    },
  },
  {
    name: 'Firefox "Copy as cURL" form login',
    input:
      `curl 'https://www.example.org/login' -X POST -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' ` +
      `-H 'Accept: */*' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' ` +
      `-H 'Content-Type: application/x-www-form-urlencoded' -H 'Origin: https://www.example.org' -H 'Connection: keep-alive' ` +
      `-H 'Cookie: session=abc; theme=dark' --data-raw 'username=jo%40x.com&password=p%26ss+word'`,
    expected: {
      name: 'POST /login',
      method: 'POST',
      url: 'https://www.example.org/login',
      params: [],
      headers: [
        { key: 'User-Agent', value: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
        { key: 'Accept', value: '*/*' },
        { key: 'Accept-Language', value: 'en-US,en;q=0.5' },
        { key: 'Accept-Encoding', value: 'gzip, deflate, br, zstd' },
        { key: 'Origin', value: 'https://www.example.org' },
        { key: 'Connection', value: 'keep-alive' },
        { key: 'Cookie', value: 'session=abc; theme=dark' },
      ],
      auth: inherit,
      body: {
        type: 'urlencoded',
        fields: [
          { key: 'username', value: 'jo@x.com' },
          { key: 'password', value: 'p&ss word' },
        ],
      },
    },
  },
  {
    name: 'Postman code export (basic auth header, multiline JSON)',
    input: `curl --location 'https://api.example.com/v1/orders' \\
--header 'Content-Type: application/json' \\
--header 'Authorization: Basic dXNlcjpwYXNz' \\
--data '{
    "item": "book",
    "qty": 1
}'`,
    expected: {
      name: 'POST /v1/orders',
      method: 'POST',
      url: 'https://api.example.com/v1/orders',
      params: [],
      headers: [],
      auth: { type: 'basic', username: 'user', password: 'pass' },
      body: { type: 'json', content: '{\n  "item": "book",\n  "qty": 1\n}' },
    },
  },
  {
    name: 'older Postman export with --request',
    input: `curl --location --request PUT 'https://x.example.com/y?id=7' --header 'X-Api-Key: k'`,
    expected: {
      name: 'PUT /y',
      method: 'PUT',
      url: 'https://x.example.com/y',
      params: [{ key: 'id', value: '7' }],
      headers: [{ key: 'X-Api-Key', value: 'k' }],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'GitHub REST API docs',
    input: `curl -L \\
  -X POST \\
  -H "Accept: application/vnd.github+json" \\
  -H "Authorization: Bearer <YOUR-TOKEN>" \\
  -H "X-GitHub-Api-Version: 2022-11-28" \\
  https://api.github.com/repos/OWNER/REPO/issues \\
  -d '{"title":"Found a bug","body":"I'\\''m having a problem with this.","assignees":["octocat"]}'`,
    expected: {
      name: 'POST /repos/OWNER/REPO/issues',
      method: 'POST',
      url: 'https://api.github.com/repos/OWNER/REPO/issues',
      params: [],
      headers: [
        { key: 'Accept', value: 'application/vnd.github+json' },
        { key: 'X-GitHub-Api-Version', value: '2022-11-28' },
      ],
      auth: { type: 'bearer', token: '<YOUR-TOKEN>' },
      body: {
        type: 'json',
        content:
          '{\n  "title": "Found a bug",\n  "body": "I\'m having a problem with this.",\n  "assignees": [\n    "octocat"\n  ]\n}',
      },
    },
  },
  {
    name: 'Stripe docs (-u key: and multiple -d)',
    input: `curl https://api.stripe.com/v1/customers \\
  -u sk_test_fake: \\
  -d name="Jenny Rosen" \\
  --data-urlencode email="jenny.rosen+test@example.com" \\
  -d "metadata[order_id]"=6735`,
    expected: {
      name: 'POST /v1/customers',
      method: 'POST',
      url: 'https://api.stripe.com/v1/customers',
      params: [],
      headers: [],
      auth: { type: 'basic', username: 'sk_test_fake', password: '' },
      body: {
        type: 'urlencoded',
        fields: [
          { key: 'name', value: 'Jenny Rosen' },
          { key: 'email', value: 'jenny.rosen+test@example.com' },
          { key: 'metadata[order_id]', value: '6735' },
        ],
      },
    },
  },
  {
    name: 'Stripe with plain -d only',
    input: `curl https://api.stripe.com/v1/refunds -u sk_test_x: -d charge=ch_1 -d amount=100`,
    expected: {
      name: 'POST /v1/refunds',
      method: 'POST',
      url: 'https://api.stripe.com/v1/refunds',
      params: [],
      headers: [],
      auth: { type: 'basic', username: 'sk_test_x', password: '' },
      body: {
        type: 'urlencoded',
        fields: [
          { key: 'charge', value: 'ch_1' },
          { key: 'amount', value: '100' },
        ],
      },
    },
  },
  {
    name: '--json',
    input: `curl --json '{"a":1}' https://x.io/api`,
    expected: {
      name: 'POST /api',
      method: 'POST',
      url: 'https://x.io/api',
      params: [],
      headers: [],
      auth: inherit,
      body: { type: 'json', content: '{\n  "a": 1\n}' },
    },
  },
  {
    name: 'multipart upload with -F',
    input: `curl -X POST https://upload.example.com/files \\
  -H 'Authorization: Bearer tok' \\
  -F 'file=@/tmp/photo.png;type=image/png' \\
  -F 'description=Holiday photo' \\
  -F 'meta=<meta.json' \\
  --form-string 'raw=@not-a-file'`,
    expected: {
      name: 'POST /files',
      method: 'POST',
      url: 'https://upload.example.com/files',
      params: [],
      headers: [],
      auth: { type: 'bearer', token: 'tok' },
      body: {
        type: 'form',
        fields: [
          { key: 'file', value: '/tmp/photo.png', kind: 'file' },
          { key: 'description', value: 'Holiday photo', kind: 'text' },
          { key: 'meta', value: 'meta.json', kind: 'file' },
          { key: 'raw', value: '@not-a-file', kind: 'text' },
        ],
      },
    },
  },
  {
    name: 'Chrome raw multipart body is parsed into form fields',
    input: `curl 'https://example.com/up' -H 'content-type: multipart/form-data; boundary=----WebKitFormBoundaryX' --data-raw $'------WebKitFormBoundaryX\\r\\nContent-Disposition: form-data; name="title"\\r\\n\\r\\nHello\\r\\n------WebKitFormBoundaryX\\r\\nContent-Disposition: form-data; name="doc"; filename="a.pdf"\\r\\nContent-Type: application/pdf\\r\\n\\r\\n\\r\\n------WebKitFormBoundaryX--\\r\\n'`,
    expected: {
      name: 'POST /up',
      method: 'POST',
      url: 'https://example.com/up',
      params: [],
      headers: [],
      auth: inherit,
      body: {
        type: 'form',
        fields: [
          { key: 'title', value: 'Hello', kind: 'text' },
          { key: 'doc', value: 'a.pdf', kind: 'file' },
        ],
      },
    },
  },
  {
    name: '-G with --data-urlencode moves data into params',
    input: `curl -G https://api.example.com/search --data-urlencode 'q=hello world & more' -d limit=5`,
    expected: {
      name: 'GET /search',
      method: 'GET',
      url: 'https://api.example.com/search',
      params: [
        { key: 'q', value: 'hello world & more' },
        { key: 'limit', value: '5' },
      ],
      headers: [],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'cookies, user agent, referer, cookie file ignored',
    input: `curl -b 'a=1; b=2' -b cookies.txt -A 'MyAgent/1.0' -e https://ref.example.com http://localhost:3000/me`,
    expected: {
      name: 'GET /me',
      method: 'GET',
      url: 'http://localhost:3000/me',
      params: [],
      headers: [
        { key: 'User-Agent', value: 'MyAgent/1.0' },
        { key: 'Referer', value: 'https://ref.example.com' },
        { key: 'Cookie', value: 'a=1; b=2' },
      ],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'attached and combined short flags, --flag=value, schemeless URL, ignored value flags',
    input: `curl -sSLk -XPATCH -H'X-Trace: 1' -d'{"on":true}' -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time=10 'example.com:8080/api/toggle?x'`,
    expected: {
      name: 'PATCH /api/toggle',
      method: 'PATCH',
      url: 'http://example.com:8080/api/toggle',
      params: [{ key: 'x', value: '' }],
      headers: [{ key: 'X-Trace', value: '1' }],
      auth: inherit,
      body: { type: 'json', content: '{\n  "on": true\n}' },
    },
  },
  {
    name: '--url with readme.io style',
    input: `curl --request DELETE \\
     --url 'https://api.example.com/users/42' \\
     --header 'accept: application/json'`,
    expected: {
      name: 'DELETE /users/42',
      method: 'DELETE',
      url: 'https://api.example.com/users/42',
      params: [],
      headers: [{ key: 'accept', value: 'application/json' }],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'leading "$ " prompt, fragment dropped, encoded params decoded',
    input: `$ curl "https://example.com/a/b?name=J%C3%BCrgen&tags=x%2Cy#section"`,
    expected: {
      name: 'GET /a/b',
      method: 'GET',
      url: 'https://example.com/a/b',
      params: [
        { key: 'name', value: 'Jürgen' },
        { key: 'tags', value: 'x,y' },
      ],
      headers: [],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'empty header value, header removal, unknown flag with value, pipe',
    input: `curl --some-new-flag value123 -H 'X-Empty;' -H 'Expect:' https://example.com/x | jq .`,
    expected: {
      name: 'GET /x',
      method: 'GET',
      url: 'https://example.com/x',
      params: [],
      headers: [{ key: 'X-Empty', value: '' }],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: 'PowerShell backtick continuation',
    input: 'curl.exe `\n  -H "Accept: application/json" `\n  https://example.com/ps',
    expected: {
      name: 'GET /ps',
      method: 'GET',
      url: 'https://example.com/ps',
      params: [],
      headers: [{ key: 'Accept', value: 'application/json' }],
      auth: inherit,
      body: { type: 'none' },
    },
  },
  {
    name: '--data-binary @file',
    input: `curl https://example.com/blob -H 'Content-Type: application/octet-stream' --data-binary @payload.bin`,
    expected: {
      name: 'POST /blob',
      method: 'POST',
      url: 'https://example.com/blob',
      params: [],
      headers: [{ key: 'Content-Type', value: 'application/octet-stream' }],
      auth: inherit,
      body: { type: 'binary', filePath: 'payload.bin' },
    },
  },
  {
    name: '-d @file, -u user:pass, -I, templated URL',
    input: `curl -I -u 'admin:s3cr:et' '{{baseUrl}}/health'`,
    expected: {
      name: 'HEAD /health',
      method: 'HEAD',
      url: '{{baseUrl}}/health',
      params: [],
      headers: [],
      auth: { type: 'basic', username: 'admin', password: 's3cr:et' },
      body: { type: 'none' },
    },
  },
  {
    name: '-d @file becomes binary body',
    input: `curl -d @body.json -H 'Content-Type: application/json' https://example.com/import`,
    expected: {
      name: 'POST /import',
      method: 'POST',
      url: 'https://example.com/import',
      params: [],
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      auth: inherit,
      body: { type: 'binary', filePath: 'body.json' },
    },
  },
  {
    name: '-T upload defaults to PUT',
    input: `curl -T ./report.csv https://files.example.com/reports/`,
    expected: {
      name: 'PUT /reports/',
      method: 'PUT',
      url: 'https://files.example.com/reports/',
      params: [],
      headers: [],
      auth: inherit,
      body: { type: 'binary', filePath: './report.csv' },
    },
  },
  {
    name: 'plain text body keeps content-type header',
    input: `curl https://example.com/echo -H 'Content-Type: text/xml' -d '<a>1</a>'`,
    expected: {
      name: 'POST /echo',
      method: 'POST',
      url: 'https://example.com/echo',
      params: [],
      headers: [{ key: 'Content-Type', value: 'text/xml' }],
      auth: inherit,
      body: { type: 'raw', content: '<a>1</a>' },
    },
  },
  {
    name: 'bare host without path',
    input: `curl example.com`,
    expected: {
      name: 'GET /',
      method: 'GET',
      url: 'http://example.com',
      params: [],
      headers: [],
      auth: inherit,
      body: { type: 'none' },
    },
  },
];

describe('parseCurl (real-world samples)', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    expect(parseCurl(input)).toEqual(expected);
  });
});

describe('parseCurl errors', () => {
  it.each([
    ['empty input', '', /Nothing to import/],
    ['not curl', 'wget https://example.com', /Not a curl command/],
    ['no URL', 'curl -s -H "Accept: */*"', /No URL/],
    ['unterminated quote', "curl 'https://example.com", /quotes/],
    ['missing option value', 'curl https://example.com -H', /Missing value/],
    ['unsupported method', 'curl -X PROPFIND https://example.com', /Unsupported HTTP method/],
  ])('%s', (_name, input, msg) => {
    expect(() => parseCurl(input)).toThrow(CurlParseError);
    expect(() => parseCurl(input)).toThrow(msg);
  });
});
