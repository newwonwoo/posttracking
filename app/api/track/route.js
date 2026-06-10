import { XMLParser } from 'fast-xml-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// data.go.kr 공식 문서의 Service URL은 http 입니다.
const ENDPOINTS = [
  {
    id: 'combined',
    name: '우체국 통합 종적조회',
    url: 'http://openapi.epost.go.kr/trace/retrieveLongitudinalCombinedService/retrieveLongitudinalCombinedService/getLongitudinalCombinedList',
    parser: parseCombinedXml
  },
  {
    id: 'domestic',
    name: '국내우편물 종적조회',
    url: 'http://openapi.epost.go.kr/trace/retrieveLongitudinalService/retrieveLongitudinalService/getLongitudinalDomesticList',
    parser: parseDomesticXml
  }
];

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
  // data.go.kr 인증키는 Encoding/Decoding 2종이 있어 이중 인코딩 방지 처리
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
  const errorMessage = findFirstValue(data, ['errorMessage', 'errMsg', 'returnAuthMsg', 'returnReasonCode', 'resultMsg', 'resultCode']);
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
  const ok = Boolean(status || events.length || dlvyDe);

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
    errorMessage: ok ? '' : (errorMessage || '조회 결과가 없거나 응답을 해석하지 못했습니다.')
  };
}

function parseCombinedXml(xml, requestedTrackingNo) {
  const data = parser.parse(xml);
  const successYn = findFirstValue(data, ['successYn']);
  const errorMessage = findFirstValue(data, ['errorMessage', 'errMsg', 'resultMsg', 'returnAuthMsg', 'returnReasonCode', 'resultCode']);
  const trackState = findFirstValue(data, ['trackState']);
  const receiveDate = normalizeDate(findFirstValue(data, ['receiveDate']));
  const senderData = normalizeDate(findFirstValue(data, ['senderData']));
  const responseTime = findFirstValue(data, ['responseTime']);
  const regiNo = findFirstValue(data, ['regiNo', 'requestRegiNo']) || requestedTrackingNo;

  const ok = successYn === 'Y' || Boolean(trackState || receiveDate);
  return {
    ok,
    trackingNo: regiNo,
    deliveryStatus: trackState,
    deliveryDate: receiveDate,
    mailType: '',
    treatmentType: '',
    senderNameMasked: findFirstValue(data, ['senderName']),
    receiverNameMasked: findFirstValue(data, ['receiveName']),
    lastDate: receiveDate || senderData || '',
    lastTime: responseTime ? String(responseTime).slice(11, 16) : '',
    postOffice: '',
    processStatus: trackState,
    detail: '',
    events: [],
    errorMessage: ok ? '' : (errorMessage || '조회 결과가 없습니다.')
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
    .replace(/<ServiceKey>.*?<\/ServiceKey>/gi, '<ServiceKey>***</ServiceKey>')
    .slice(0, 500);
}

async function callEpost(endpoint, serviceKey, rgist, { retries = 2, timeoutMs = 15000 } = {}) {
  const url = `${endpoint.url}?ServiceKey=${serviceKeyQueryValue(serviceKey)}&rgist=${encodeURIComponent(rgist)}`;
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
          'User-Agent': 'Mozilla/5.0 epost-tracking-vercel/0.1.5'
        }
      });
      const text = await res.text();
      clearTimeout(timer);
      return { endpointId: endpoint.id, endpointName: endpoint.name, status: res.status, text, attempt: attempt + 1 };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }

  throw new Error(`${endpoint.name} fetch failed: ${describeFetchError(lastError)}`);
}

async function tryEndpoint(endpoint, serviceKey, rgist, debug) {
  try {
    const response = await callEpost(endpoint, serviceKey, rgist);
    const parsed = endpoint.parser(response.text, rgist);
    return {
      endpoint: endpoint.id,
      endpointName: endpoint.name,
      httpStatus: response.status,
      attempt: response.attempt,
      parsed,
      ok: parsed.ok,
      errorMessage: parsed.ok ? '' : parsed.errorMessage,
      rawExcerpt: debug ? rawExcerpt(response.text) : undefined
    };
  } catch (error) {
    return {
      endpoint: endpoint.id,
      endpointName: endpoint.name,
      ok: false,
      thrown: true,
      errorMessage: error?.message || 'fetch failed'
    };
  }
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
  if (rgist.length < 10 || rgist.length > 15) {
    return Response.json({ ok: false, errorMessage: '등기번호 형식이 올바르지 않습니다.', trackingNo: rgist }, { status: 400 });
  }

  const diagnostics = [];

  for (const endpoint of ENDPOINTS) {
    const result = await tryEndpoint(endpoint, serviceKey, rgist, debug);
    diagnostics.push(result);
    if (result.ok) {
      return Response.json({
        ...result.parsed,
        source: endpoint.id,
        diagnostics: debug ? diagnostics : undefined
      });
    }
  }

  const message = diagnostics
    .map((d) => `${d.endpointName}: ${d.errorMessage || '조회 실패'}`)
    .join(' / ');

  return Response.json({
    ok: false,
    trackingNo: rgist,
    errorMessage: message || '조회 결과가 없습니다.',
    source: 'none',
    diagnostics: debug ? diagnostics : undefined
  });
}
