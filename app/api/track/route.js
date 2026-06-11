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


function makeEventHistoryText(events) {
  return (events || [])
    .map((event) => [event.date, event.time, event.postOffice, event.processStatus, event.detail].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ');
}

function pickUndeliveredReason(status, events) {
  const s = String(status || '');
  const eventList = Array.isArray(events) ? events : [];
  const reasonKeywords = ['반송', '미배달', '배달불능', '부재', '폐문', '주소', '수취인', '보관', '이사', '불명', '거절'];
  const isDelivered = s.includes('배달완료') || s.includes('배송완료');
  const hasIssueStatus = !isDelivered && (s.includes('반송') || reasonKeywords.some((kw) => s.includes(kw)));
  if (!hasIssueStatus) return '';

  const candidates = [...eventList].reverse();
  const detailed = candidates.find((event) => {
    const text = `${event.processStatus || ''} ${event.detail || ''}`;
    return event.detail && reasonKeywords.some((kw) => text.includes(kw));
  });
  if (detailed?.detail) return detailed.detail;

  const anyDetail = candidates.find((event) => event.detail)?.detail;
  if (anyDetail) return anyDetail;

  const issueProcess = candidates.find((event) => {
    const text = `${event.processStatus || ''} ${event.detail || ''}`;
    return reasonKeywords.some((kw) => text.includes(kw));
  });
  return issueProcess?.processStatus || '';
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
  const completionEvent = [...events].reverse().find((event) => {
    const text = `${event.processStatus || ''} ${event.detail || ''}`;
    // dlvyDe가 비는 경우가 있어, 최종 완료성 상태의 종적 일자를 보조 일자로 씁니다.
    // 정상 배달완료는 '배달완료일', 반송배달은 '반송물이 발송인 쪽에 배달된 일자'로 해석합니다.
    return text.includes('배달완료') || text.includes('배송완료') || text.includes('반송배달') || text.includes('반송완료');
  });

  const status = deliveryStatusByDoc || last?.processStatus || '';
  const eventHistoryText = makeEventHistoryText(events);
  const undeliveredReason = pickUndeliveredReason(status, events);
  // 문서상 배달일자는 dlvyDe가 정답. 다만 일부 응답에서 dlvyDe가 비어 있으면 완료성 종적 이벤트 날짜로 보정합니다.
  const deliveryDate = deliveryDateByDoc || completionEvent?.date || '';
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
    statusDate: last?.date || deliveryDate || '',
    statusDateLabel: status && status.includes('반송') ? '반송배달일자' : (status && (status.includes('배달완료') || status.includes('배송완료'))) ? '배달완료일자' : '최종처리일자',
    mailType: pstmtrKnd,
    treatmentType: trtmntSe,
    senderNameMasked: applcntNm,
    receiverNameMasked: addrseNm,
    lastDate: last?.date || deliveryDate || '',
    lastTime: last?.time || '',
    postOffice: last?.postOffice || '',
    processStatus: last?.processStatus || status || '',
    detail: last?.detail || '',
    undeliveredReason,
    eventHistoryText,
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
      firstProcessSttus: firstValueFromNodes(nodes, ['processSttus']),
      firstDetailDc: firstValueFromNodes(nodes, ['detailDc']),
      eventCount: events.length
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


function isTransientNetworkErrorMessage(message) {
  const s = String(message || '').toUpperCase();
  return s.includes('ECONNRESET') || s.includes('ETIMEDOUT') || s.includes('UND_ERR') || s.includes('ABORT') || s.includes('FETCH FAILED') || s.includes('EAI_AGAIN');
}

function rawExcerpt(text) {
  return String(text || '')
    .replace(/(serviceKey|ServiceKey)=([^&<]+)/gi, '$1=***')
    .replace(/<ServiceKey>.*?<\/ServiceKey>/gi, '<ServiceKey>***</ServiceKey>')
    .slice(0, 1000);
}

async function callDomestic(serviceKey, rgist, { retries = 4, timeoutMs = 25000 } = {}) {
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
          'User-Agent': 'Mozilla/5.0 epost-tracking-vercel/0.2.5',
          'Connection': 'close'
        }
      });
      const text = await res.text();
      clearTimeout(timer);
      return { status: res.status, text, attempt: attempt + 1, urlForDebug: `${DOMESTIC_ENDPOINT.url}?rgist=${rgist}&serviceKey=***` };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) await sleep(Math.min(8000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250));
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
    const errorMessage = error?.message || 'fetch failed';
    const transient = isTransientNetworkErrorMessage(errorMessage);
    return Response.json({
      ok: false,
      trackingNo: rgist,
      errorMessage,
      transient,
      retryable: transient,
      source: DOMESTIC_ENDPOINT.id,
      diagnostics: debug ? [{ endpoint: DOMESTIC_ENDPOINT.id, thrown: true, transient, errorMessage: error?.message || String(error) }] : undefined
    }, { status: transient ? 503 : 502 });
  }
}
