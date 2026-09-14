// Compiled-language targets: Go, Java (OkHttp, HttpClient), Kotlin, C#, Swift, Dart, Rust.
import type { ResolvedRequest } from '../model';
import {
  baseName,
  bodyAllowed,
  contentType,
  dq,
  indent,
  LITERAL_NL,
  longestRun,
  mergedHeaders,
  requestHeaders,
  textBody,
  urlEncodeFields,
} from './common';

const OCTET = 'application/octet-stream';

// ---------- Go ----------

function goString(s: string): string {
  return s.includes('\n') && !/[`\r]/.test(s) ? '`' + s.replaceAll('\n', LITERAL_NL) + '`' : dq(s, { unicode: 'x2' });
}

export function toGo(req: ResolvedRequest): string {
  const body = req.body;
  const imports = new Set(['fmt', 'io', 'net/http']);
  const setup: string[] = [];
  let payload = 'nil';
  let formContentType: string | undefined;

  switch (body.type) {
    case 'text':
      imports.add('strings');
      setup.push(`payload := strings.NewReader(${goString(textBody(req))})`);
      payload = 'payload';
      break;
    case 'urlencoded':
      imports.add('strings');
      setup.push(`payload := strings.NewReader(${goString(urlEncodeFields(body.fields))})`);
      payload = 'payload';
      break;
    case 'form':
      imports.add('bytes');
      imports.add('mime/multipart');
      setup.push('payload := &bytes.Buffer{}', 'writer := multipart.NewWriter(payload)');
      for (const f of body.fields) {
        if (f.kind === 'file') {
          imports.add('os');
          imports.add('path/filepath');
          setup.push(
            '{',
            `\tfile, err := os.Open(${goString(f.value)})`,
            '\tif err != nil {\n\t\tpanic(err)\n\t}',
            '\tdefer file.Close()',
            `\tpart, err := writer.CreateFormFile(${goString(f.key)}, filepath.Base(${goString(f.value)}))`,
            '\tif err != nil {\n\t\tpanic(err)\n\t}',
            '\tif _, err := io.Copy(part, file); err != nil {\n\t\tpanic(err)\n\t}',
            '}',
          );
        } else {
          setup.push(`_ = writer.WriteField(${goString(f.key)}, ${goString(f.value)})`);
        }
      }
      setup.push('if err := writer.Close(); err != nil {\n\tpanic(err)\n}');
      payload = 'payload';
      formContentType = 'writer.FormDataContentType()';
      break;
    case 'binary':
      imports.add('os');
      setup.push(`payload, err := os.Open(${goString(body.filePath)})`, 'if err != nil {\n\tpanic(err)\n}', 'defer payload.Close()');
      payload = 'payload';
      break;
    case 'none':
      break;
  }

  const main: string[] = [...setup];
  if (setup.length) main.push('');
  main.push(`req, err := http.NewRequest(${goString(req.method)}, ${goString(req.url)}, ${payload})`, 'if err != nil {\n\tpanic(err)\n}');
  for (const h of requestHeaders(req)) main.push(`req.Header.Add(${goString(h.key)}, ${goString(h.value)})`);
  if (body.type === 'urlencoded' && !contentType(req)) main.push('req.Header.Set("Content-Type", "application/x-www-form-urlencoded")');
  if (formContentType) main.push(`req.Header.Set("Content-Type", ${formContentType})`);
  main.push(
    '',
    'res, err := http.DefaultClient.Do(req)',
    'if err != nil {\n\tpanic(err)\n}',
    'defer res.Body.Close()',
    '',
    'body, err := io.ReadAll(res.Body)',
    'if err != nil {\n\tpanic(err)\n}',
    'fmt.Println(string(body))',
  );

  return [
    'package main',
    '',
    'import (',
    ...[...imports].sort().map((i) => `\t"${i}"`),
    ')',
    '',
    'func main() {',
    indent(main.join('\n'), '\t'),
    '}',
    '',
  ].join('\n');
}

// ---------- Java / Kotlin ----------

function javaString(s: string, pad: string): string {
  if (!s.includes('\n')) return dq(s);
  // Text block (Java 15+): the closing delimiter sits on the last line so no trailing newline is added.
  const content = s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
  return '"""\n' + content.split('\n').map((l) => pad + l).join('\n') + '"""';
}

function okHttpBody(req: ResolvedRequest, lang: 'java' | 'kotlin'): { setup: string[]; expr: string; imports: string[] } {
  const body = req.body;
  const java = lang === 'java';
  const str = (s: string) => (java ? javaString(s, '    ') : kotlinString(s));
  const media = (ct: string) => (java ? `MediaType.parse(${dq(ct)})` : `${kotlinString(ct)}.toMediaType()`);
  const decl = java ? 'RequestBody body = ' : 'val body = ';
  const end = java ? ';' : '';
  const ct = contentType(req);
  switch (body.type) {
    case 'text':
      return {
        imports: [],
        setup: java
          ? [`${decl}RequestBody.create(${str(textBody(req))}, ${ct ? media(ct) : 'null'});`]
          : [`${decl}${str(textBody(req))}.toRequestBody(${ct ? media(ct) : ''})`],
        expr: 'body',
      };
    case 'urlencoded': {
      const adds = body.fields.map((f) => `    .add(${dq(f.key, { dollar: !java })}, ${dq(f.value, { dollar: !java })})`);
      return {
        imports: ['okhttp3.FormBody'],
        setup: [`${decl}${java ? 'new ' : ''}FormBody.Builder()`, ...adds, `    .build()${end}`],
        expr: 'body',
      };
    }
    case 'form': {
      const parts = body.fields.map((f) => {
        const k = dq(f.key, { dollar: !java });
        if (f.kind !== 'file') return `    .addFormDataPart(${k}, ${dq(f.value, { dollar: !java })})`;
        const file = java
          ? `RequestBody.create(new File(${dq(f.value)}), MediaType.parse("${OCTET}"))`
          : `File(${dq(f.value, { dollar: true })}).asRequestBody("${OCTET}".toMediaType())`;
        return `    .addFormDataPart(${k}, ${dq(baseName(f.value), { dollar: !java })}, ${file})`;
      });
      const hasFile = body.fields.some((f) => f.kind === 'file');
      return {
        imports: ['okhttp3.MultipartBody', ...(hasFile ? ['java.io.File', ...(java ? [] : ['okhttp3.RequestBody.Companion.asRequestBody'])] : [])],
        setup: [`${decl}${java ? 'new ' : ''}MultipartBody.Builder()`, `    .setType(MultipartBody.FORM)`, ...parts, `    .build()${end}`],
        expr: 'body',
      };
    }
    case 'binary':
      return {
        imports: ['java.io.File', ...(java ? [] : ['okhttp3.RequestBody.Companion.asRequestBody'])],
        setup: java
          ? [`${decl}RequestBody.create(new File(${dq(body.filePath)}), ${media(ct ?? OCTET)});`]
          : [`${decl}File(${dq(body.filePath, { dollar: true })}).asRequestBody(${media(ct ?? OCTET)})`],
        expr: 'body',
      };
    case 'none':
      return { imports: [], setup: [], expr: bodyAllowed(req.method) && !['DELETE', 'OPTIONS'].includes(req.method) ? (java ? 'RequestBody.create(new byte[0], null)' : 'ByteArray(0).toRequestBody()') : 'null' };
  }
}

export function toJavaOkHttp(req: ResolvedRequest): string {
  const { setup, expr, imports } = okHttpBody(req, 'java');
  const bodyExpr = bodyAllowed(req.method) ? expr : 'null';
  const lines = [
    ...['okhttp3.MediaType', 'okhttp3.OkHttpClient', 'okhttp3.Request', 'okhttp3.RequestBody', 'okhttp3.Response', ...imports]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .map((i) => `import ${i};`),
    '',
    'OkHttpClient client = new OkHttpClient();',
    ...(bodyAllowed(req.method) ? setup : []),
    'Request request = new Request.Builder()',
    `    .url(${dq(req.url)})`,
    `    .method(${dq(req.method)}, ${bodyExpr})`,
    ...requestHeaders(req, { dropContentType: req.body.type !== 'none' }).map((h) => `    .addHeader(${dq(h.key)}, ${dq(h.value)})`),
    '    .build();',
    'try (Response response = client.newCall(request).execute()) {',
    '    System.out.println(response.body().string());',
    '}',
    '',
  ];
  return lines.join('\n');
}

/** Headers java.net.http refuses to set. */
const JAVA_RESTRICTED = new Set(['connection', 'content-length', 'expect', 'host', 'upgrade']);

export function toJavaHttpClient(req: ResolvedRequest): string {
  const body = req.body;
  const imports = ['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse'];
  const pre: string[] = [];
  let publisher = 'HttpRequest.BodyPublishers.noBody()';
  const headers = requestHeaders(req).filter((h) => !JAVA_RESTRICTED.has(h.key.toLowerCase()));

  switch (body.type) {
    case 'text':
      publisher = `HttpRequest.BodyPublishers.ofString(${javaString(textBody(req), '        ')})`;
      break;
    case 'urlencoded':
      publisher = `HttpRequest.BodyPublishers.ofString(${dq(urlEncodeFields(body.fields))})`;
      if (!contentType(req)) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
      break;
    case 'form':
      pre.push('// java.net.http has no multipart/form-data builder; use the OkHttp snippet for form uploads.');
      break;
    case 'binary':
      imports.push('java.nio.file.Path');
      publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(body.filePath)}))`;
      break;
    case 'none':
      break;
  }

  return [
    ...imports.sort().map((i) => `import ${i};`),
    '',
    ...pre,
    'HttpClient client = HttpClient.newHttpClient();',
    'HttpRequest request = HttpRequest.newBuilder()',
    `    .uri(URI.create(${dq(req.url)}))`,
    ...headers.map((h) => `    .header(${dq(h.key)}, ${dq(h.value)})`),
    `    .method(${dq(req.method)}, ${publisher})`,
    '    .build();',
    'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
    'System.out.println(response.body());',
    '',
  ].join('\n');
}

function kotlinString(s: string): string {
  if (!s.includes('\n') || s.includes('"""')) return dq(s, { dollar: true });
  // Function replacer: a replacement *string* would treat "$'" as a special pattern.
  const content = s.replace(/\$/g, () => "${'$'}");
  return '"""\n' + content.split('\n').map((l) => (l ? '    ' + l : l)).join('\n') + '\n""".trimIndent()';
}

export function toKotlinOkHttp(req: ResolvedRequest): string {
  const { setup, expr, imports } = okHttpBody(req, 'kotlin');
  const k = (s: string) => dq(s, { dollar: true });
  const extra = ['okhttp3.OkHttpClient', 'okhttp3.Request', ...imports];
  if (req.body.type === 'text' || req.body.type === 'none') extra.push('okhttp3.RequestBody.Companion.toRequestBody');
  if (contentType(req) || req.body.type === 'form' || req.body.type === 'binary') extra.push('okhttp3.MediaType.Companion.toMediaType');
  return [
    ...extra
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .map((i) => `import ${i}`),
    '',
    'val client = OkHttpClient()',
    ...(bodyAllowed(req.method) ? setup : []),
    'val request = Request.Builder()',
    `    .url(${k(req.url)})`,
    `    .method(${k(req.method)}, ${bodyAllowed(req.method) ? expr : 'null'})`,
    ...requestHeaders(req, { dropContentType: req.body.type !== 'none' }).map((h) => `    .addHeader(${k(h.key)}, ${k(h.value)})`),
    '    .build()',
    'client.newCall(request).execute().use { response ->',
    '    println(response.body!!.string())',
    '}',
    '',
  ].join('\n');
}

// ---------- C# ----------

function csString(s: string, pad: string): string {
  if (!s.includes('\n')) return dq(s, { unicode: 'u4' });
  // Raw string literal (C# 11): more quotes than any run inside, content indented like the closing delimiter.
  const quotes = '"'.repeat(Math.max(3, longestRun(s, '"') + 1));
  return `${quotes}\n${s.split('\n').map((l) => (l ? pad + l : l)).join('\n')}\n${pad}${quotes}`;
}

const CS_METHODS: Record<string, string> = {
  GET: 'HttpMethod.Get',
  POST: 'HttpMethod.Post',
  PUT: 'HttpMethod.Put',
  PATCH: 'HttpMethod.Patch',
  DELETE: 'HttpMethod.Delete',
  HEAD: 'HttpMethod.Head',
  OPTIONS: 'HttpMethod.Options',
};

export function toCSharp(req: ResolvedRequest): string {
  const body = req.body;
  const usings = ['System', 'System.Net.Http'];
  const lines = ['using var client = new HttpClient();', `var request = new HttpRequestMessage(${CS_METHODS[req.method]}, ${dq(req.url)});`];
  const ct = contentType(req);
  for (const h of requestHeaders(req, { dropContentType: true })) {
    lines.push(`request.Headers.TryAddWithoutValidation(${dq(h.key)}, ${dq(h.value)});`);
  }
  let setType = !!ct;
  switch (body.type) {
    case 'text':
      lines.push(`request.Content = new StringContent(${csString(textBody(req), '')});`);
      break;
    case 'urlencoded':
      usings.push('System.Collections.Generic');
      lines.push('request.Content = new FormUrlEncodedContent(new[]', '{');
      for (const f of body.fields) lines.push(`    new KeyValuePair<string, string>(${dq(f.key)}, ${dq(f.value)}),`);
      lines.push('});');
      break;
    case 'form':
      setType = false;
      lines.push('var form = new MultipartFormDataContent();');
      for (const f of body.fields) {
        if (f.kind === 'file') {
          usings.push('System.IO');
          lines.push(`form.Add(new StreamContent(File.OpenRead(${dq(f.value)})), ${dq(f.key)}, ${dq(baseName(f.value))});`);
        } else {
          lines.push(`form.Add(new StringContent(${dq(f.value)}), ${dq(f.key)});`);
        }
      }
      lines.push('request.Content = form;');
      break;
    case 'binary':
      usings.push('System.IO');
      lines.push(`request.Content = new StreamContent(File.OpenRead(${dq(body.filePath)}));`);
      break;
    case 'none':
      setType = false;
      break;
  }
  if (setType && ct) {
    usings.push('System.Net.Http.Headers');
    lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${dq(ct)});`);
  }
  lines.push(
    '',
    'var response = await client.SendAsync(request);',
    'Console.WriteLine(await response.Content.ReadAsStringAsync());',
    '',
  );
  return [...[...new Set(usings)].sort().map((u) => `using ${u};`), '', ...lines].join('\n');
}

// ---------- Swift ----------

function swiftString(s: string): string {
  if (!s.includes('\n')) return dq(s, { unicode: 'braces' });
  const content = s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
  return `"""\n${content}\n"""`;
}

export function toSwift(req: ResolvedRequest): string {
  const body = req.body;
  const lines = [
    'import Foundation',
    '',
    `var request = URLRequest(url: URL(string: ${swiftString(req.url)})!)`,
    `request.httpMethod = ${swiftString(req.method)}`,
  ];
  for (const h of requestHeaders(req)) {
    lines.push(`request.addValue(${swiftString(h.value)}, forHTTPHeaderField: ${swiftString(h.key)})`);
  }
  switch (body.type) {
    case 'text':
      lines.push(`request.httpBody = Data(${swiftString(textBody(req))}.utf8)`);
      break;
    case 'urlencoded':
      if (!contentType(req)) lines.push('request.addValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")');
      lines.push(`request.httpBody = Data(${swiftString(urlEncodeFields(body.fields))}.utf8)`);
      break;
    case 'form':
      lines.push('', 'let boundary = "Boundary-\\(UUID().uuidString)"', 'var body = Data()');
      for (const f of body.fields) {
        lines.push('body.append(Data("--\\(boundary)\\r\\n".utf8))');
        if (f.kind === 'file') {
          const head = `Content-Disposition: form-data; name="${f.key}"; filename="${baseName(f.value)}"\r\nContent-Type: ${OCTET}\r\n\r\n`;
          lines.push(
            `body.append(Data(${swiftString(head)}.utf8))`,
            `body.append(try Data(contentsOf: URL(fileURLWithPath: ${swiftString(f.value)})))`,
            'body.append(Data("\\r\\n".utf8))',
          );
        } else {
          lines.push(`body.append(Data(${swiftString(`Content-Disposition: form-data; name="${f.key}"\r\n\r\n${f.value}\r\n`)}.utf8))`);
        }
      }
      lines.push(
        'body.append(Data("--\\(boundary)--\\r\\n".utf8))',
        'request.setValue("multipart/form-data; boundary=\\(boundary)", forHTTPHeaderField: "Content-Type")',
        'request.httpBody = body',
      );
      break;
    case 'binary':
      lines.push(`request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${swiftString(body.filePath)}))`);
      break;
    case 'none':
      break;
  }
  lines.push('', 'let (data, _) = try await URLSession.shared.data(for: request)', 'print(String(decoding: data, as: UTF8.self))', '');
  return lines.join('\n');
}

// ---------- Dart ----------

function dartString(s: string): string {
  const esc = (x: string) => x.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
  if (s.includes('\n')) return `'''${LITERAL_NL}${esc(s).replace(/'''/g, "\\'''").replaceAll('\n', LITERAL_NL)}'''`;
  return "'" + esc(s).replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
}

function dartMap(entries: { key: string; value: string }[], pad: string): string {
  return `{\n${entries.map((e) => `${pad}  ${dartString(e.key)}: ${dartString(e.value)},`).join('\n')}\n${pad}}`;
}

export function toDart(req: ResolvedRequest): string {
  const body = req.body;
  const imports = ["import 'package:http/http.dart' as http;"];
  const main: string[] = [];
  const isForm = body.type === 'form';
  main.push(`final request = http.${isForm ? 'MultipartRequest' : 'Request'}(${dartString(req.method)}, Uri.parse(${dartString(req.url)}));`);
  const headers = mergedHeaders(req);
  if (headers.length) main.push(`request.headers.addAll(${dartMap(headers, '')});`);
  switch (body.type) {
    case 'text':
      main.push(`request.body = ${dartString(textBody(req))};`);
      break;
    case 'urlencoded':
      if (!contentType(req)) main.push("request.headers['Content-Type'] = 'application/x-www-form-urlencoded';");
      main.push(`request.body = ${dartString(urlEncodeFields(body.fields))};`);
      break;
    case 'form': {
      const text = body.fields.filter((f) => f.kind !== 'file');
      if (text.length) main.push(`request.fields.addAll(${dartMap(text, '')});`);
      for (const f of body.fields.filter((x) => x.kind === 'file')) {
        main.push(`request.files.add(await http.MultipartFile.fromPath(${dartString(f.key)}, ${dartString(f.value)}));`);
      }
      break;
    }
    case 'binary':
      imports.unshift("import 'dart:io';");
      main.push(`request.bodyBytes = await File(${dartString(body.filePath)}).readAsBytes();`);
      break;
    case 'none':
      break;
  }
  main.push('', 'final response = await request.send();', 'print(await response.stream.bytesToString());');
  return [...imports, '', 'Future<void> main() async {', indent(main.join('\n'), '  '), '}', ''].join('\n');
}

// ---------- Rust ----------

function rustString(s: string): string {
  if (!s.includes('\n') && !s.includes('"')) return dq(s, { unicode: 'braces' });
  let hashes = '#';
  while (s.includes('"' + hashes)) hashes += '#';
  return `r${hashes}"${s.replaceAll('\n', LITERAL_NL)}"${hashes}`;
}

export function toRust(req: ResolvedRequest): string {
  const body = req.body;
  const chain = [`client`, `    .request(reqwest::Method::${req.method}, ${rustString(req.url)})`];
  const pre: string[] = [];
  for (const h of requestHeaders(req)) chain.push(`    .header(${rustString(h.key)}, ${rustString(h.value)})`);
  switch (body.type) {
    case 'text':
      pre.push(`let body = ${rustString(textBody(req))};`);
      chain.push('    .body(body)');
      break;
    case 'urlencoded':
      chain.push(`    .form(&[${body.fields.map((f) => `(${rustString(f.key)}, ${rustString(f.value)})`).join(', ')}])`);
      break;
    case 'form':
      pre.push('let form = reqwest::multipart::Form::new()');
      for (const f of body.fields) {
        pre.push(
          f.kind === 'file'
            ? `    .file(${rustString(f.key)}, ${rustString(f.value)})\n    .await?`
            : `    .text(${rustString(f.key)}, ${rustString(f.value)})`,
        );
      }
      pre[pre.length - 1] += ';';
      chain.push('    .multipart(form)');
      break;
    case 'binary':
      pre.push(`let body = tokio::fs::read(${rustString(body.filePath)}).await?;`);
      chain.push('    .body(body)');
      break;
    case 'none':
      break;
  }
  chain.push('    .send()', '    .await?;');
  const main = [
    'let client = reqwest::Client::new();',
    ...(pre.length ? ['', ...pre] : []),
    '',
    `let response = ${chain.join('\n')}`,
    '',
    'println!("{}", response.text().await?);',
    'Ok(())',
  ];
  return [
    '#[tokio::main]',
    'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
    indent(main.join('\n'), '    '),
    '}',
    '',
  ].join('\n');
}
