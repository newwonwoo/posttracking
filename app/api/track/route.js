import { XMLParser } from 'fast-xml-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 국내우편물 배송조회서비스 명세서 기준
// 호출 URL: http://openapi.epost.go.kr/trace/retrieveLongitudinalService/retrieveLongitudinalService/getLongitudinalDomesticList?rgist=...&serviceKey=...
const DOMESTIC_ENDPOINT = {
  id: 'domestic',
  name: '국내우편물 등기 배송조회 서비스',
  url: 'http://openapi.epost.go.kr/trace/retrieveLongitudinalService/retrieveLongitudinalService/getLongitudinalDomesticList'
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  parseTagValue: false,
  trimValues: true
});

function serviceKeyQueryValue(key) {
  if (!key) return '';
  const trimmed = String(key).trim();
  // data.go.kr의 Encoding 키는 이미 % 인코딩되어 있으므로 재인코딩하지 않습니다.
  return /%[0-9A-Fa-f]{2}/.test(trimmed) ? trimmed : encodeURIComponent(trimmed);
}

function normalizeTrackingNo(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function normalizeDate(value) {
  if (!value) return '';
  const s = String(value).trim();
  const compact = s.replace(/[^0-9]/g, '');
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (compact.length === 12) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)} ${compact.slice(8, 10)}:${compact.slice(10, 12)}`;
  return s.replace(/\./g, '-');
}

function normalizeTime(value) {
  if (!value) return '';
  const s = String(value).trim();
  const compact = s.replace(/[^0-9]/g, '');
  if (compact.length === 4) return `${compact.slice(0, 2)}:${compact.slice(2, 4)}`;
  return s;
}

function walk(obj, cb) {
  if (!obj || typeof obj !== 'object') return;
  cb(obj);
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, cb);
    } else if (value && typeof value === 'object') {
      walk(value, cb);
    }
  }
}

function findFirstValue(obj, keys) {
  let found = '';
  walk(obj, (node) => {
    if (found) return;
    for (const key of keys) {
      if (node[key] !== undefined && node[key] !== null && String(node[key]).trim() !== '') {
        found = String(node[key]).trim();
        return;
      }
    }
  });
  return found;
}

function collectDomesticEvents(obj) {
  const events = [];
  walk(obj, (node) => {
    const hasEventField = node.dlvyDate || node.dlvyTime || node.nowLc || node.processSttus || node.detailDc;
    if (!hasEventField) return;
    events.push({
      date: normalizeDate(node.dlvyDate),
      time: normalizeTime(node.dlvyTime),
      postOffice: node.nowLc ? String(node.nowLc).trim() : '',
      processStatus: node.processSttus ? String(node.processSttus).trim() : '',
      detail: node.detailDc ? String(node.detailDc).trim() : ''
    });
  });
  events.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return events;
}

function parseDomesticXml(xml, requestedTrackingNo) {
  const data = parser.parse(xml);

  const successYN = findFirstValue(data, ['successYN', 'successYn', 'successyn']);
  const returnCode = findFirstValue(data, ['returnCode', 'resultCode', 'returnReasonCode']);
  const errMsg = findFirstValue(data, ['errMsg', 'errorMessage', 'resultMsg', 'returnAuthMsg']);

  const dlvySttus = findFirstValue(data, ['dlvySttus']);
  const dlvyDe = normalizeDate(findFirstValue(data, ['dlvyDe']));
  const pstmtrKnd = findFirstValue(data, ['pstmtrKnd']);
  const trtmntSe = findFirstValue(data, ['trtmntSe']);
  const applcntNm = findFirstValue(data, ['applcntNm']);
  const addrseNm = findFirstValue(data, ['addrseNm']);
  const rgist = findFirstValue(data, ['rgist']) || requestedTrackingNo;
  const events = collectDomesticEvents(data);
  const last = events.length ? events[events.length - 1] : null;

  const status = dlvySttus || last?.processStatus || '';
  const ok = successYN === 'Y' || Boolean(status || events.length || dlvyDe);

  let errorMessage = '';
  if (!ok) {
    errorMessage = errMsg || (returnCode ? `returnCode=${returnCode}` : '') || '조회 결과가 없거나 응답을 해석하지 못했습니다.';
  }

  return {
    ok,
    trackingNo: rgist,
    deliveryStatus: status,
    deliveryDate: dlvyDe,
    mailType: pstmtrKnd,
    treatmentType: trtmntSe,
    senderNameMasked: applcntNm,
    receiverNameMasked: addrseNm,
    lastDate: last?.date || dlvyDe || '',
    lastTime: last?.time || '',
    postOffice: last?.postOffice || '',
    processStatus: last?.processStatus || status || '',
    detail: last?.detail || '',
    events,
    successYN,
    returnCode,
    errorMessage
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(error) {
  const cause = error?.cause;
  const parts = [];
  if (error?.name) parts.push(error.name);
  if (error?.message) parts.push(error.message);
  if (cause?.code) parts.push(`cause.code=${cause.code}`);
  if (cause?.errno) parts.push(`cause.errno=${cause.errno}`);
  if (cause?.syscall) parts.push(`cause.syscall=${cause.syscall}`);
  if (cause?.address) parts.push(`cause.address=${cause.address}`);
  if (cause?.port) parts.push(`cause.port=${cause.port}`);
  if (cause?.message) parts.push(`cause.message=${cause.message}`);
  return parts.join(' | ') || 'fetch failed';
}

function rawExcerpt(text) {
  return String(text || '')
    .replace(/(serviceKey|ServiceKey)=([^&<]+)/gi, '$1=***')
    .replace(/<ServiceKey>.*?<\/ServiceKey>/gi, '<ServiceKey>***</ServiceKey>')
    .slice(0, 800);
}

async function callDomestic(serviceKey, rgist, { retries = 2, timeoutMs = 20000 } = {}) {
  // 명세서에는 파라미터명이 serviceKey 소문자로 되어 있어 이를 기본으로 사용합니다.
  const url = `${DOMESTIC_ENDPOINT.url}?rgist=${encodeURIComponent(rgist)}&serviceKey=${serviceKeyQueryValue(serviceKey)}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'application/xml,text/xml,*/*',
          'User-Agent': 'Mozilla/5.0 epost-tracking-vercel/0.1.6'
        }
      });
      const text = await res.text();
      clearTimeout(timer);
      return { status: res.status, text, attempt: attempt + 1, urlForDebug: `${DOMESTIC_ENDPOINT.url}?rgist=${rgist}&serviceKey=***` };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }

  throw new Error(`${DOMESTIC_ENDPOINT.name} fetch failed: ${describeFetchError(lastError)}`);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rgist = normalizeTrackingNo(searchParams.get('rgist'));
  const debug = searchParams.get('debug') === '1';
  const serviceKey = process.env.EPOST_SERVICE_KEY;

  if (!serviceKey) {
    return Response.json({ ok: false, errorMessage: '서버 환경변수 EPOST_SERVICE_KEY가 설정되지 않았습니다.' }, { status: 500 });
  }
  if (!rgist) {
    return Response.json({ ok: false, errorMessage: '등기번호가 비어 있습니다.' }, { status: 400 });
  }
  // 명세서에는 등기번호 13자리 설명과 항목크기 15가 함께 표기되어 있어 13~15자리까지 허용합니다.
  if (rgist.length < 13 || rgist.length > 15) {
    return Response.json({ ok: false, errorMessage: `등기번호 형식이 올바르지 않습니다. 숫자 13~15자리여야 합니다. 현재 ${rgist.length}자리입니다.`, trackingNo: rgist }, { status: 400 });
  }

  try {
    const response = await callDomestic(serviceKey, rgist);
    const parsed = parseDomesticXml(response.text, rgist);

    if (parsed.ok) {
      return Response.json({
        ...parsed,
        source: DOMESTIC_ENDPOINT.id,
        diagnostics: debug ? [{ endpoint: DOMESTIC_ENDPOINT.id, httpStatus: response.status, attempt: response.attempt, parsed, rawExcerpt: rawExcerpt(response.text), url: response.urlForDebug }] : undefined
      });
    }

    return Response.json({
      ok: false,
      trackingNo: rgist,
      errorMessage: parsed.errorMessage,
      source: DOMESTIC_ENDPOINT.id,
      diagnostics: debug ? [{ endpoint: DOMESTIC_ENDPOINT.id, httpStatus: response.status, attempt: response.attempt, parsed, rawExcerpt: rawExcerpt(response.text), url: response.urlForDebug }] : undefined
    });
  } catch (error) {
    return Response.json({
      ok: false,
      trackingNo: rgist,
      errorMessage: error?.message || 'fetch failed',
      source: DOMESTIC_ENDPOINT.id,
      diagnostics: debug ? [{ endpoint: DOMESTIC_ENDPOINT.id, thrown: true, errorMessage: error?.message || String(error) }] : undefined
    }, { status: 502 });
  }
}
