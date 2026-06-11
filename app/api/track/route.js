import { XMLParser } from 'fast-xml-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 공공데이터포털 문서 기준: 과학기술정보통신부 우정사업본부_국내우편물 종적 조회 서비스
// 상세기능: 건별국내등기종적조회
// Service URL: http://openapi.epost.go.kr/trace/retrieveLongitudinalService/retrieveLongitudinalService/getLongitudinalDomesticList
// 요청값: serviceKey(공공데이터포털 인증키), rgist(등기번호)
// 주요 응답값: dlvyDe(배달일자), dlvySttus(배달상태), dlvyDate(종적 날짜), dlvyTime(종적 시간), nowLc(현재위치), processSttus(처리현황), detailDc(상세설명)
const DOMESTIC_ENDPOINT = {
  id: 'domestic',
  name: '국내우편물 종적 조회 서비스',
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
  // 공공데이터포털 Encoding 키는 이미 % 인코딩되어 있으므로 재인코딩하지 않습니다.
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

function collectNodes(obj) {
  const nodes = [];
  walk(obj, (node) => nodes.push(node));
  return nodes;
}

function getStringValue(node, key) {
  const value = node?.[key];
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    if (value.text !== undefined && value.text !== null) return String(value.text).trim();
    return '';
  }
  return String(value).trim();
}

function firstValueFromNodes(nodes, keys) {
  for (const node of nodes) {
    for (const key of keys) {
      const v = getStringValue(node, key);
      if (v) return v;
    }
  }
  return '';
}

function findFirstValue(obj, keys) {
  return firstValueFromNodes(collectNodes(obj), keys);
}

function collectDomesticEvents(data) {
  const events = [];
  const nodes = collectNodes(data);
  for (const node of nodes) {
    const rawDate = getStringValue(node, 'dlvyDate');
    const rawTime = getStringValue(node, 'dlvyTime');
    const rawLocation = getStringValue(node, 'nowLc');
    const rawProcess = getStringValue(node, 'processSttus');
    const rawDetail = getStringValue(node, 'detailDc');
    const hasEventField = rawDate || rawTime || rawLocation || rawProcess || rawDetail;
    if (!hasEventField) continue;
    events.push({
      date: normalizeDate(rawDate),
      time: normalizeTime(rawTime),
      postOffice: rawLocation,
      processStatus: rawProcess,
      detail: rawDetail
    });
  }

  // 같은 이벤트가 여러 부모 노드 탐색 중 중복 수집되는 경우를 제거합니다.
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    const key = [event.date, event.time, event.postOffice, event.processStatus, event.detail].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }

  unique.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return unique;
}

function parseDomesticXml(xml, requestedTrackingNo) {
  const data = parser.parse(xml);
  const nodes = collectNodes(data);

  const successYN = findFirstValue(data, ['successYN', 'successYn', 'successyn']);
  const returnCode = findFirstValue(data, ['returnCode', 'resultCode', 'returnReasonCode']);
  const errMsg = findFirstValue(data, ['errMsg', 'errorMessage', 'resultMsg', 'returnAuthMsg', 'returnMsg']);

  // 공공데이터포털 국내우편물 종적조회 문서의 정확한 필드명 기준.
  // 배달일자 = dlvyDe, 배달상태 = dlvySttus 입니다.
  // dlvyDate는 배달일자가 아니라 종적목록의 각 이벤트 날짜입니다.
  const deliveryDateByDoc = normalizeDate(firstValueFromNodes(nodes, ['dlvyDe']));
  const deliveryStatusByDoc = firstValueFromNodes(nodes, ['dlvySttus']);

  const pstmtrKnd = firstValueFromNodes(nodes, ['pstmtrKnd']);
  const trtmntSe = firstValueFromNodes(nodes, ['trtmntSe']);
  const applcntNm = firstValueFromNodes(nodes, ['applcntNm']);
  const addrseNm = firstValueFromNodes(nodes, ['addrseNm']);
  const rgist = firstValueFromNodes(nodes, ['rgist']) || requestedTrackingNo;

  const events = collectDomesticEvents(data);
  const last = events.length ? events[events.length - 1] : null;
  const deliveredEvent = [...events].reverse().find((event) => {
    const text = `${event.processStatus || ''} ${event.detail || ''}`;
    return text.includes('배달완료') || text.includes('배송완료');
  });

  const status = deliveryStatusByDoc || last?.processStatus || '';
  // 문서상 배달일자는 dlvyDe가 정답. 다만 일부 응답에서 dlvyDe가 비어 있으면 종적목록의 배달완료 이벤트 날짜로 보정합니다.
  const deliveryDate = deliveryDateByDoc || deliveredEvent?.date || '';
  const ok = successYN === 'Y' || Boolean(status || events.length || deliveryDate || rgist);

  let errorMessage = '';
  if (!ok) {
    errorMessage = errMsg || (returnCode ? `returnCode=${returnCode}` : '') || '조회 결과가 없거나 응답을 해석하지 못했습니다.';
  }

  return {
    ok,
    trackingNo: rgist,
    deliveryStatus: status,
    deliveryDate,
    mailType: pstmtrKnd,
    treatmentType: trtmntSe,
    senderNameMasked: applcntNm,
    receiverNameMasked: addrseNm,
    lastDate: last?.date || deliveryDate || '',
    lastTime: last?.time || '',
    postOffice: last?.postOffice || '',
    processStatus: last?.processStatus || status || '',
    detail: last?.detail || '',
    events,
    successYN,
    returnCode,
    errorMessage,
    rawFields: {
      dlvyDe: deliveryDateByDoc,
      dlvySttus: deliveryStatusByDoc,
      firstDlvyDate: firstValueFromNodes(nodes, ['dlvyDate']),
      firstDlvyTime: firstValueFromNodes(nodes, ['dlvyTime']),
      firstNowLc: firstValueFromNodes(nodes, ['nowLc']),
      firstProcessSttus: firstValueFromNodes(nodes, ['processSttus'])
    }
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
    .slice(0, 1000);
}

async function callDomestic(serviceKey, rgist, { retries = 2, timeoutMs = 20000 } = {}) {
  // 국내우편물 종적조회는 epost 쪽 예제에서 serviceKey를 사용합니다.
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
          Accept: 'application/xml,text/xml,*/*',
          'User-Agent': 'Mozilla/5.0 epost-tracking-vercel/0.1.9'
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
  // 문서 설명은 등기번호 13자리, 항목크기는 15로 표기되어 있어 13~15자리 허용.
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
