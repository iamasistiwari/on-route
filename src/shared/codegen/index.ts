import type { ResolvedRequest } from '../model';
import type { CodeTarget } from '../protocol';
import { toCurl } from './curl';
import { toAxios } from './axios';
import { toHttp, toHttpie, toPowerShell, toWget } from './shell';
import { toFetch, toPhpCurl, toPhpGuzzle, toPythonHttpClient, toPythonRequests, toRubyNetHttp } from './scripting';
import { toCSharp, toDart, toGo, toJavaHttpClient, toJavaOkHttp, toKotlinOkHttp, toRust, toSwift } from './compiled';

export const generators: Record<CodeTarget, (req: ResolvedRequest) => string> = {
  curl: (r) => toCurl(r),
  wget: toWget,
  httpie: toHttpie,
  http: toHttp,
  powershell: toPowerShell,
  fetch: toFetch,
  axios: toAxios,
  'python-requests': toPythonRequests,
  'python-http': toPythonHttpClient,
  go: toGo,
  'java-okhttp': toJavaOkHttp,
  'java-httpclient': toJavaHttpClient,
  'kotlin-okhttp': toKotlinOkHttp,
  csharp: toCSharp,
  'php-curl': toPhpCurl,
  'php-guzzle': toPhpGuzzle,
  ruby: toRubyNetHttp,
  swift: toSwift,
  dart: toDart,
  rust: toRust,
};

export { toCurl, toAxios };
