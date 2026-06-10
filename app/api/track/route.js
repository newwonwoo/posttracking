import { XMLParser } from 'fast-xml-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOMESTIC_ENDPOINT = 'http://openapi.epost.go.kr/trace/retrieveLongitudinalService/retrieveLongitudinalService/getLongitudinalDomesticList';
const COMBINED_ENDPOINT = 'http://openapi.epost.go.kr/trace/retrieveLongitudinalCombinedService/retrieveLongitudinalCombinedService/getLongitudinalCombinedList';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  parseTagValue: false,
  trimValues: true
});

function serviceKeyQueryValue(key) {
  if (!key) return '';
  // data.go.kr 인증키는 Encoding/Decoding 2종이 있어 이중 인코딩 방지 처리
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
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

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
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
  const errorMessage = findFirstValue(data, ['errorMessage', 'errMsg', 'returnAuthMsg', 'returnReasonCode', 'resultMsg']);
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
  const errorMessage = findFirstValue(data, ['errorMessage', 'errMsg', 'resultMsg']);
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

async function callEpost(endpoint, serviceKey, rgist) {
  const url = `${endpoint}?ServiceKey=${serviceKeyQueryValue(serviceKey)}&rgist=${encodeURIComponent(rgist)}`;
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: { 'Accept': 'application/xml,text/xml,*/*' }
  });
  const text = await res.text();
  return { status: res.status, text };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rgist = normalizeTrackingNo(searchParams.get('rgist'));
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

  try {
    const domestic = await callEpost(DOMESTIC_ENDPOINT, serviceKey, rgist);
    const domesticParsed = parseDomesticXml(domestic.text, rgist);
    if (domesticParsed.ok) {
      return Response.json({ ...domesticParsed, source: 'domestic' });
    }

    const combined = await callEpost(COMBINED_ENDPOINT, serviceKey, rgist);
    const combinedParsed = parseCombinedXml(combined.text, rgist);
    if (combinedParsed.ok) {
      return Response.json({ ...combinedParsed, source: 'combined' });
    }

    return Response.json({
      ok: false,
      trackingNo: rgist,
      errorMessage: domesticParsed.errorMessage || combinedParsed.errorMessage || '조회 결과가 없습니다.',
      source: 'none'
    });
  } catch (error) {
    return Response.json({
      ok: false,
      trackingNo: rgist,
      errorMessage: error?.message || '우체국 API 호출 중 오류가 발생했습니다.'
    }, { status: 500 });
  }
}
