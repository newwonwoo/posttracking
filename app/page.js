'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

const STORAGE_PREFIX = 'epost-tracking-job:';
const STORAGE_INDEX = 'epost-tracking-job-index:v1';
const CURRENT_JOB = 'epost-tracking-current-job:v1';

const CANDIDATES = {
  // 순번은 엑셀 컬럼을 읽지 않고 업로드 행 순서 기준으로 1부터 자동 생성합니다.
  trackingNo: ['등기번호', '우편물번호', '송장번호', '배송번호', '등기', 'tracking', 'rgist'],
  // 화면/CSV에는 고객번호로 표시합니다. 내부 변수명은 기존 호환을 위해 internalId 유지.
  internalId: ['고객번호', '고객관리번호', '고객NO', '고객No', '고객no', '고객ID', '고객id']
};

const DEFAULT_COLUMNS = [
  '순번', '등기번호', '고객번호',
  '배달상태', '상태기준일자', '최종처리시간', '처리우체국', '배달/반송일자',
  '작업상태', '조회결과', '실패사유', '재조회횟수', '조회시각', '우편물종류', '취급구분'
];

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayCompact() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function cleanTrackingNo(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

function normalizeHeader(value) {
  return cleanString(value).replace(/\s+/g, '').toLowerCase();
}

function findColumn(headers, type) {
  const candidates = CANDIDATES[type].map(normalizeHeader);
  const normalizedHeaders = headers.map(normalizeHeader);

  for (const candidate of candidates) {
    const exactIndex = normalizedHeaders.findIndex((h) => h === candidate);
    if (exactIndex >= 0) return headers[exactIndex];
  }

  for (const candidate of candidates) {
    const containsIndex = normalizedHeaders.findIndex((h) => h.includes(candidate) || candidate.includes(h));
    if (containsIndex >= 0 && normalizedHeaders[containsIndex]) return headers[containsIndex];
  }
  return '';
}

function makeRowId(row, index = 0) {
  // 순번은 표시/출력용이므로 rowId에 쓰지 않습니다.
  // 고객번호가 등기번호와 같거나 비어 있어도 행 순서(sourceIndex)까지 넣어 중복을 막습니다.
  return [row.sourceIndex ?? index + 2, row.trackingNo, row.internalId].map(cleanString).join('|');
}

function normalizeRowsSequence(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const sourceIndex = row.sourceIndex ?? index + 2;
    const normalized = {
      ...row,
      sourceIndex,
      seq: String(index + 1)
    };
    return { ...normalized, rowId: makeRowId(normalized, index) };
  });
}

function makeFingerprint(rows) {
  const nums = rows.map((r) => r.trackingNo).filter(Boolean).sort();
  const head = nums.slice(0, 50).join(',');
  const tail = nums.slice(-50).join(',');
  return `${nums.length}:${head}:${tail}`;
}

function overlapRatio(aRows, bRows) {
  const a = new Set(aRows.map((r) => r.trackingNo).filter(Boolean));
  const b = new Set(bRows.map((r) => r.trackingNo).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common += 1;
  return common / Math.max(a.size, b.size);
}

function safeJsonParse(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readIndex() {
  if (typeof window === 'undefined') return [];
  const parsed = safeJsonParse(localStorage.getItem(STORAGE_INDEX), []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeIndex(index) {
  const safeIndex = Array.isArray(index) ? index : [];
  localStorage.setItem(STORAGE_INDEX, JSON.stringify(safeIndex.slice(0, 30)));
}

function saveJob(job) {
  const updatedJob = { ...job, rows: normalizeRowsSequence(job?.rows || []), updatedAt: nowText() };
  localStorage.setItem(STORAGE_PREFIX + updatedJob.jobId, JSON.stringify(updatedJob));
  localStorage.setItem(CURRENT_JOB, updatedJob.jobId);
  const index = readIndex().filter((item) => item.jobId !== updatedJob.jobId);
  index.unshift({
    jobId: updatedJob.jobId,
    jobName: updatedJob.jobName,
    sourceFileName: updatedJob.sourceFileName,
    createdAt: updatedJob.createdAt,
    updatedAt: updatedJob.updatedAt,
    fingerprint: updatedJob.fingerprint,
    total: updatedJob.rows.length,
    done: updatedJob.rows.filter((r) => ['성공', '수동입력'].includes(r.workStatus)).length
  });
  writeIndex(index);
  return updatedJob;
}

function loadJob(jobId) {
  if (!jobId || typeof window === 'undefined') return null;
  const parsed = safeJsonParse(localStorage.getItem(STORAGE_PREFIX + jobId), null);
  return parsed && Array.isArray(parsed.rows) ? { ...parsed, rows: normalizeRowsSequence(parsed.rows) } : null;
}

function statusClass(status) {
  if (status === '성공' || status === '수동입력') return 'good';
  if (status === '실패') return 'bad';
  if (status === '조회중') return 'warn';
  if (status === '중단됨') return 'warn';
  if (status === '제외') return 'muted';
  return '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCsv(rows, mode = 'all') {
  const filtered = rows.filter((r) => {
    if (mode === 'success') return ['성공', '수동입력'].includes(r.workStatus);
    if (mode === 'fail') return r.workStatus === '실패';
    return true;
  });

  const escape = (value) => {
    const s = String(value ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [DEFAULT_COLUMNS.join(',')];
  filtered.forEach((r) => {
    lines.push([
      r.seq,
      r.trackingNo,
      r.internalId,
      r.deliveryStatus,
      r.lastDate,
      r.lastTime,
      r.postOffice,
      r.deliveryDate,
      r.workStatus,
      r.queryResult,
      r.failReason,
      r.retryCount,
      r.checkedAt,
      r.mailType,
      r.treatmentType
    ].map(escape).join(','));
  });
  return '\ufeff' + lines.join('\r\n');
}

function downloadBlob(content, filename, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseSheetToRows(sheetJson, mapping) {
  const [headerRow, ...dataRows] = sheetJson;
  const headers = headerRow.map(cleanString);
  const colIndex = (name) => headers.indexOf(name);

  const trackingIdx = colIndex(mapping.trackingNo);
  const internalIdx = colIndex(mapping.internalId);

  return dataRows
    .map((arr, idx) => {
      const row = {
        sourceIndex: idx + 2,
        // 순번은 엑셀 값이 아니라 업로드된 데이터 행 순서대로 1부터 자동 생성합니다.
        seq: String(idx + 1),
        trackingNo: trackingIdx >= 0 ? cleanTrackingNo(arr[trackingIdx]) : '',
        internalId: internalIdx >= 0 ? cleanString(arr[internalIdx]) : '',
        deliveryStatus: '',
        deliveryDate: '',
        lastDate: '',
        lastTime: '',
        postOffice: '',
        processStatus: '',
        detail: '',
        mailType: '',
        treatmentType: '',
        workStatus: '대기',
        queryResult: '',
        failReason: '',
        retryCount: 0,
        checkedAt: '',
        selected: false
      };
      row.rowId = makeRowId(row, idx);
      if (!row.trackingNo) {
        row.workStatus = '실패';
        row.queryResult = '실패';
        row.failReason = '등기번호 없음';
      }
      return row;
    })
    .filter((r) => r.seq || r.trackingNo || r.internalId);
}

export default function Page() {
  const [headers, setHeaders] = useState([]);
  const [sheetJson, setSheetJson] = useState([]);
  const [mapping, setMapping] = useState({ seq: '', trackingNo: '', internalId: '' });
  const [job, setJob] = useState(null);
  const [savedJobs, setSavedJobs] = useState([]);
  const [matchingJob, setMatchingJob] = useState(null);
  const [message, setMessage] = useState('엑셀 또는 CSV 파일을 업로드해 주세요.');
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [intervalMs, setIntervalMs] = useState(2300);
  const [filter, setFilter] = useState('전체');
  const [search, setSearch] = useState('');
  const [selectedRowId, setSelectedRowId] = useState('');
  const [apiTestNo, setApiTestNo] = useState('');
  const [autoDownloadCsv, setAutoDownloadCsv] = useState(true);
  const stopRef = useRef(false);
  const pausedRef = useRef(false);

  useEffect(() => {
    setSavedJobs(readIndex());
    const current = loadJob(localStorage.getItem(CURRENT_JOB));
    if (current) {
      const rows = current.rows.map((r) => r.workStatus === '조회중' ? { ...r, workStatus: '중단됨' } : r);
      const restored = saveJob({ ...current, rows });
      setJob(restored);
      setMessage(`최근 작업을 복구했습니다: ${restored.jobName}`);
    }
  }, []);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  const stats = useMemo(() => {
    const rows = job?.rows || [];
    const count = (s) => rows.filter((r) => r.workStatus === s).length;
    return {
      total: rows.length,
      success: rows.filter((r) => ['성공', '수동입력'].includes(r.workStatus)).length,
      fail: count('실패'),
      waiting: count('대기'),
      running: count('조회중'),
      stopped: count('중단됨'),
      excluded: count('제외')
    };
  }, [job]);

  const visibleRows = useMemo(() => {
    const rows = job?.rows || [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const statusOk = filter === '전체' || r.workStatus === filter || (filter === '성공' && ['성공', '수동입력'].includes(r.workStatus));
      const qOk = !q || [r.seq, r.trackingNo, r.internalId, r.deliveryStatus, r.failReason].some((v) => String(v || '').toLowerCase().includes(q));
      return statusOk && qOk;
    }).slice(0, 500);
  }, [job, filter, search]);

  async function handleFile(file) {
    if (!file) return;
    const buf = await file.arrayBuffer();
    let workbook;
    if (file.name.toLowerCase().endsWith('.csv')) {
      const text = new TextDecoder('utf-8').decode(buf);
      workbook = XLSX.read(text, { type: 'string' });
    } else {
      workbook = XLSX.read(buf, { type: 'array', cellDates: false });
    }
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: false });
    if (!json.length) {
      setMessage('빈 파일입니다.');
      return;
    }
    const newHeaders = json[0].map(cleanString).filter(Boolean);
    const newMapping = {
      seq: '',
      trackingNo: findColumn(newHeaders, 'trackingNo'),
      internalId: findColumn(newHeaders, 'internalId')
    };
    setHeaders(newHeaders);
    setSheetJson(json);
    setMapping(newMapping);

    const candidateRows = parseSheetToRows(json, newMapping);
    const index = readIndex();
    let best = null;
    for (const item of index) {
      const old = loadJob(item.jobId);
      if (!old) continue;
      const ratio = overlapRatio(candidateRows, old.rows || []);
      if (!best || ratio > best.ratio) best = { ...old, ratio };
    }

    if (!newMapping.trackingNo) {
      setMatchingJob(best && best.ratio >= 0.6 ? best : null);
      setMessage('등기번호 컬럼을 자동 인식하지 못했습니다. 등기번호 컬럼을 선택한 뒤 [이 설정으로 작업 생성]을 눌러 주세요.');
      return;
    }

    // 파일 업로드만 하면 자동으로 작업 생성/병합 후 조회까지 시작합니다.
    if (best && best.ratio >= 0.6) {
      const oldByTracking = new Map((best.rows || []).map((r) => [r.trackingNo, r]));
      const mergedRows = candidateRows.map((row) => {
        const old = oldByTracking.get(row.trackingNo);
        if (!old) return row;
        return {
          ...row,
          deliveryStatus: old.deliveryStatus || '',
          deliveryDate: old.deliveryDate || '',
          lastDate: old.lastDate || '',
          lastTime: old.lastTime || '',
          postOffice: old.postOffice || '',
          processStatus: old.processStatus || '',
          detail: old.detail || '',
          mailType: old.mailType || '',
          treatmentType: old.treatmentType || '',
          workStatus: old.workStatus === '조회중' ? '중단됨' : old.workStatus,
          queryResult: old.queryResult || '',
          failReason: old.failReason || '',
          retryCount: old.retryCount || 0,
          checkedAt: old.checkedAt || ''
        };
      });
      const merged = saveJob({
        ...best,
        mapping: newMapping,
        sourceFileName: file.name,
        fingerprint: makeFingerprint(mergedRows),
        rows: mergedRows
      });
      setJob(merged);
      setSavedJobs(readIndex());
      setMatchingJob(null);
      setMessage(`이전 작업과 ${Math.round(best.ratio * 100)}% 일치하여 병합했습니다. 자동 조회를 시작합니다.`);
      setTimeout(() => startQuery('resume', merged), 100);
      return;
    }

    const newJob = {
      jobId: `job_${Date.now()}`,
      jobName: `등기배송조회_${todayCompact()}`,
      sourceFileName: file.name,
      createdAt: nowText(),
      updatedAt: nowText(),
      mapping: newMapping,
      fingerprint: makeFingerprint(candidateRows),
      rows: candidateRows
    };
    const saved = saveJob(newJob);
    setJob(saved);
    setSavedJobs(readIndex());
    setMatchingJob(null);
    setMessage(`파일을 읽고 작업을 자동 생성했습니다. 총 ${candidateRows.length}건, 자동 조회를 시작합니다.`);
    setTimeout(() => startQuery('resume', saved), 100);
  }

  function createJobFromMapping() {
    const rows = parseSheetToRows(sheetJson, mapping);
    if (!rows.length) {
      setMessage('생성할 행이 없습니다.');
      return;
    }
    if (!mapping.trackingNo) {
      setMessage('등기번호 컬럼은 반드시 선택해야 합니다.');
      return;
    }
    const newJob = {
      jobId: `job_${Date.now()}`,
      jobName: `등기배송조회_${todayCompact()}`,
      sourceFileName: 'uploaded_file',
      createdAt: nowText(),
      updatedAt: nowText(),
      mapping,
      fingerprint: makeFingerprint(rows),
      rows
    };
    const saved = saveJob(newJob);
    setJob(saved);
    setSavedJobs(readIndex());
    setMatchingJob(null);
    setMessage(`작업을 생성했습니다. 총 ${rows.length}건, 자동 조회를 시작합니다.`);
    setTimeout(() => startQuery('resume', saved), 100);
  }

  function mergeWithMatchingJob() {
    if (!matchingJob) return;
    const freshRows = parseSheetToRows(sheetJson, mapping);
    const oldByTracking = new Map((matchingJob.rows || []).map((r) => [r.trackingNo, r]));
    const mergedRows = freshRows.map((row) => {
      const old = oldByTracking.get(row.trackingNo);
      if (!old) return row;
      return {
        ...row,
        deliveryStatus: old.deliveryStatus || '',
        deliveryDate: old.deliveryDate || '',
        lastDate: old.lastDate || '',
        lastTime: old.lastTime || '',
        postOffice: old.postOffice || '',
        processStatus: old.processStatus || '',
        detail: old.detail || '',
        mailType: old.mailType || '',
        treatmentType: old.treatmentType || '',
        workStatus: old.workStatus === '조회중' ? '중단됨' : old.workStatus,
        queryResult: old.queryResult || '',
        failReason: old.failReason || '',
        retryCount: old.retryCount || 0,
        checkedAt: old.checkedAt || ''
      };
    });
    const merged = saveJob({
      ...matchingJob,
      jobId: matchingJob.jobId,
      updatedAt: nowText(),
      mapping,
      fingerprint: makeFingerprint(mergedRows),
      rows: mergedRows
    });
    setJob(merged);
    setSavedJobs(readIndex());
    setMatchingJob(null);
    setMessage('이전 작업 결과를 현재 엑셀에 병합했습니다. 자동 조회를 시작합니다.');
    setTimeout(() => startQuery('resume', merged), 100);
  }

  function updateRows(updater) {
    setJob((prev) => {
      if (!prev) return prev;
      const next = saveJob({ ...prev, rows: updater(prev.rows) });
      setSavedJobs(readIndex());
      return next;
    });
  }

  async function queryOne(row) {
    const res = await fetch(`/api/track?rgist=${encodeURIComponent(row.trackingNo)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const isTransient = data.retryable || data.transient || String(data.errorMessage || '').includes('ECONNRESET') || String(data.errorMessage || '').includes('fetch failed');
      return {
        ...row,
        workStatus: '실패',
        queryResult: isTransient ? '일시실패' : '실패',
        failReason: `${data.errorMessage || `HTTP ${res.status}`}${isTransient ? ' / 일시 네트워크 오류: 실패 건 재조회 대상' : ''}`,
        retryCount: (row.retryCount || 0) + 1,
        checkedAt: nowText()
      };
    }
    return {
      ...row,
      deliveryStatus: data.deliveryStatus || data.processStatus || '',
      deliveryDate: data.deliveryDate || ((String(data.deliveryStatus || data.processStatus || '').includes('배달완료') || String(data.deliveryStatus || data.processStatus || '').includes('배송완료') || String(data.deliveryStatus || data.processStatus || '').includes('반송배달') || String(data.deliveryStatus || data.processStatus || '').includes('반송완료')) ? (data.lastDate || '') : ''),
      lastDate: data.statusDate || data.lastDate || '',
      lastTime: data.lastTime || '',
      postOffice: data.postOffice || '',
      processStatus: data.processStatus || '',
      detail: data.detail || '',
      mailType: data.mailType || '',
      treatmentType: data.treatmentType || '',
      workStatus: '성공',
      queryResult: '성공',
      failReason: '',
      retryCount: (row.retryCount || 0) + 1,
      checkedAt: nowText()
    };
  }

  async function startQuery(mode = 'resume', sourceJob = null) {
    const activeJob = sourceJob || job;
    if (!activeJob || isRunning) return;
    stopRef.current = false;
    pausedRef.current = false;
    setIsPaused(false);
    setIsRunning(true);

    try {
      let baseRows = activeJob.rows.map((r) => r.workStatus === '조회중' ? { ...r, workStatus: '중단됨' } : r);
      if (mode === 'all') {
        baseRows = baseRows.map((r) => ({ ...r, workStatus: r.trackingNo ? '대기' : '실패', queryResult: '', failReason: r.trackingNo ? '' : '등기번호 없음' }));
      }
      let currentJob = saveJob({ ...activeJob, rows: baseRows });
      setJob(currentJob);

      const shouldRun = (r) => {
        if (!r.trackingNo || r.workStatus === '제외') return false;
        if (mode === 'fail') return r.workStatus === '실패';
        if (mode === 'all') return true;
        return ['대기', '중단됨', '실패'].includes(r.workStatus);
      };

      for (const row of currentJob.rows) {
        if (stopRef.current) break;
        while (pausedRef.current && !stopRef.current) await delay(300);
        if (!shouldRun(row)) continue;

        currentJob = loadJob(currentJob.jobId) || currentJob;
        let workingRows = currentJob.rows.map((r) => r.rowId === row.rowId ? { ...r, workStatus: '조회중', failReason: '' } : r);
        currentJob = saveJob({ ...currentJob, rows: workingRows });
        setJob(currentJob);

        const currentRow = currentJob.rows.find((r) => r.rowId === row.rowId) || row;
        const resultRow = await queryOne(currentRow);
        currentJob = loadJob(currentJob.jobId) || currentJob;
        const nextRows = currentJob.rows.map((r) => r.rowId === row.rowId ? resultRow : r);
        currentJob = saveJob({ ...currentJob, rows: nextRows });
        setJob(currentJob);
        await delay(Number(intervalMs));
      }

      const finalJob = loadJob(currentJob.jobId) || currentJob;
      const fixedRows = finalJob.rows.map((r) => r.workStatus === '조회중' ? { ...r, workStatus: '중단됨' } : r);
      const saved = saveJob({ ...finalJob, rows: fixedRows });
      setJob(saved);
      if (!stopRef.current && autoDownloadCsv) {
        downloadBlob(
          toCsv(saved.rows, 'all'),
          `등기배송조회_전체_${todayCompact()}.csv`,
          'text/csv;charset=utf-8'
        );
      }
      setMessage(stopRef.current ? '조회가 중지되었습니다. 다음에 이어서 조회할 수 있습니다.' : (autoDownloadCsv ? '조회가 완료되어 전체 결과 CSV 다운로드를 시작했습니다.' : '조회가 완료되었습니다.'));
    } catch (error) {
      const current = loadJob(activeJob.jobId) || activeJob;
      const fixedRows = current.rows.map((r) => r.workStatus === '조회중' ? { ...r, workStatus: '중단됨', failReason: error?.message || '중단됨' } : r);
      const saved = saveJob({ ...current, rows: fixedRows });
      setJob(saved);
      setMessage(`조회 중 오류가 발생했습니다: ${error?.message || error}`);
    } finally {
      setIsRunning(false);
      setIsPaused(false);
      stopRef.current = false;
      pausedRef.current = false;
      setSavedJobs(readIndex());
    }
  }

  function stopQuery() {
    stopRef.current = true;
    setIsPaused(false);
    pausedRef.current = false;
  }

  function toggleExclude(rowId) {
    updateRows((rows) => rows.map((r) => {
      if (r.rowId !== rowId) return r;
      if (r.workStatus === '제외') return { ...r, workStatus: '대기' };
      return { ...r, workStatus: '제외' };
    }));
  }

  async function testApi() {
    const no = cleanTrackingNo(apiTestNo);
    if (!no) {
      setMessage('테스트할 등기번호를 입력하세요.');
      return;
    }
    setMessage('API 테스트 중입니다...');
    try {
      const res = await fetch(`/api/track?rgist=${encodeURIComponent(no)}`, { cache: 'no-store' });
      const data = await res.json();
      setMessage(data.ok ? `API 테스트 성공: ${data.deliveryStatus || data.processStatus || '상태값 확인'} / 배달·반송일자: ${data.deliveryDate || '없음'} / 상태기준일자: ${data.statusDate || data.lastDate || '없음'}` : `API 테스트 실패: ${data.errorMessage}`);
    } catch (e) {
      setMessage(`API 테스트 오류: ${e?.message || e}`);
    }
  }

  function downloadCsv(mode) {
    if (!job) return;
    const label = mode === 'success' ? '성공건' : mode === 'fail' ? '실패건' : '전체';
    downloadBlob(toCsv(job.rows, mode), `등기배송조회_${label}_${todayCompact()}.csv`, 'text/csv;charset=utf-8');
  }

  function backupJob() {
    if (!job) return;
    downloadBlob(JSON.stringify(job, null, 2), `${job.jobName}_backup.json`, 'application/json;charset=utf-8');
  }

  async function restoreBackup(file) {
    if (!file) return;
    const text = await file.text();
    const restored = safeJsonParse(text, null);
    if (!restored?.rows) {
      setMessage('백업 JSON 형식이 올바르지 않습니다.');
      return;
    }
    const saved = saveJob({ ...restored, jobId: restored.jobId || `job_${Date.now()}`, updatedAt: nowText() });
    setJob(saved);
    setSavedJobs(readIndex());
    setMessage('백업 작업을 불러왔습니다.');
  }

  function loadSaved(jobId) {
    const loaded = loadJob(jobId);
    if (!loaded) return;
    const rows = loaded.rows.map((r) => r.workStatus === '조회중' ? { ...r, workStatus: '중단됨' } : r);
    const saved = saveJob({ ...loaded, rows });
    setJob(saved);
    setMessage(`저장된 작업을 불러왔습니다: ${saved.jobName}`);
  }

  function deleteCurrentJob() {
    if (!job) return;
    if (!confirm('현재 작업을 브라우저 저장소에서 삭제할까요? CSV/백업이 필요하면 먼저 다운로드하세요.')) return;
    localStorage.removeItem(STORAGE_PREFIX + job.jobId);
    const index = readIndex().filter((item) => item.jobId !== job.jobId);
    writeIndex(index);
    localStorage.removeItem(CURRENT_JOB);
    setJob(null);
    setSavedJobs(index);
    setMessage('현재 작업을 삭제했습니다.');
  }

  return (
    <main className="container">
      <section className="hero">
        <div>
          <p className="eyebrow">Vercel / Next.js v0.2.0</p>
          <h1>등기 배송상태 일괄조회 도구</h1>
          <p className="sub">엑셀 업로드 → 등기번호 자동조회 → 중간저장 → CSV 다운로드</p>
        </div>
        <div className="heroCard">
          <strong>개인정보 최소화</strong>
          <span>서버에는 등기번호만 전송합니다. 순번은 1부터 자동 생성하고 고객번호는 브라우저 내부 매칭용입니다.</span>
        </div>
      </section>

      <div className="notice">{message}</div>

      <section className="grid two">
        <div className="card">
          <h2>1. 엑셀/CSV 업로드</h2>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => handleFile(e.target.files?.[0])} />
          <p className="hint">첫 번째 시트를 읽습니다. 첫 행은 헤더로 인식합니다.</p>
          {Array.isArray(headers) && headers.length > 0 && (
            <div className="mapping">
              <p className="hint strongHint">순번은 엑셀 컬럼을 쓰지 않고 업로드된 행 순서대로 1부터 자동 생성합니다.</p>
              <label>등기번호 컬럼<select value={mapping.trackingNo} onChange={(e) => setMapping({ ...mapping, trackingNo: e.target.value })}><option value="">선택 안 함</option>{headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
              <label>고객번호 컬럼<select value={mapping.internalId} onChange={(e) => setMapping({ ...mapping, internalId: e.target.value })}><option value="">선택 안 함</option>{headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
              <button className="primary" onClick={createJobFromMapping}>이 설정으로 작업 생성</button>
            </div>
          )}
        </div>

        <div className="card">
          <h2>2. API 키/조회 테스트</h2>
          <p className="hint">Vercel 환경변수 <code>EPOST_SERVICE_KEY</code>가 설정되어 있어야 합니다.</p>
          <div className="inline">
            <input placeholder="등기번호 테스트" value={apiTestNo} onChange={(e) => setApiTestNo(e.target.value)} />
            <button onClick={testApi}>API 테스트</button>
          </div>
          <div className="savedBox">
            <strong>저장된 작업</strong>
            {(!Array.isArray(savedJobs) || savedJobs.length === 0) && <p className="hint">아직 저장된 작업이 없습니다.</p>}
            {(Array.isArray(savedJobs) ? savedJobs : []).slice(0, 5).map((item) => (
              <button key={item.jobId} className="savedItem" onClick={() => loadSaved(item.jobId)}>
                <span>{item.jobName}</span>
                <small>{item.done}/{item.total} · {item.updatedAt}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

      {matchingJob && (
        <section className="card highlight">
          <h2>이전 작업 감지</h2>
          <p>업로드한 파일이 이전 작업과 약 <strong>{Math.round(matchingJob.ratio * 100)}%</strong> 일치합니다.</p>
          <div className="inline wrap">
            <button className="primary" onClick={mergeWithMatchingJob}>이전 결과 병합 후 이어서 조회</button>
            <button onClick={() => setMatchingJob(null)}>새 작업으로 진행</button>
          </div>
        </section>
      )}

      {job && (
        <>
          <section className="card">
            <div className="sectionHead">
              <div>
                <h2>3. 작업 현황</h2>
                <p className="hint">{job.jobName} · 마지막 저장 {job.updatedAt}</p>
              </div>
              <div className="inline wrap">
                <button onClick={backupJob}>작업 백업 JSON</button>
                <label className="buttonLike">백업 불러오기<input className="hidden" type="file" accept=".json" onChange={(e) => restoreBackup(e.target.files?.[0])} /></label>
                <button className="danger" onClick={deleteCurrentJob}>작업 삭제</button>
              </div>
            </div>
            <div className="stats">
              <div><strong>{stats.total}</strong><span>전체</span></div>
              <div><strong>{stats.success}</strong><span>성공</span></div>
              <div><strong>{stats.fail}</strong><span>실패</span></div>
              <div><strong>{stats.waiting}</strong><span>대기</span></div>
              <div><strong>{stats.stopped}</strong><span>중단됨</span></div>
              <div><strong>{stats.excluded}</strong><span>제외</span></div>
            </div>
          </section>

          <section className="card">
            <h2>4. 자동조회</h2>
            <div className="inline wrap controls">
              <label>조회 간격<select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} disabled={isRunning}><option value={1500}>1.5초</option><option value={2300}>2.3초 권장</option><option value={3000}>3초</option><option value={5000}>5초</option></select></label>
              <label><input type="checkbox" checked={autoDownloadCsv} onChange={(e) => setAutoDownloadCsv(e.target.checked)} disabled={isRunning} /> 완료 시 전체 CSV 자동 다운로드</label>
              <button className="primary" onClick={() => startQuery('resume')} disabled={isRunning}>이어서 조회</button>
              <button onClick={() => startQuery('fail')} disabled={isRunning}>실패 건만 재조회</button>
              <button onClick={() => startQuery('all')} disabled={isRunning}>전체 재조회</button>
              <button onClick={() => setIsPaused((v) => !v)} disabled={!isRunning}>{isPaused ? '계속' : '일시정지'}</button>
              <button className="danger" onClick={stopQuery} disabled={!isRunning}>중지</button>
            </div>
            <div className="progress"><div style={{ width: `${stats.total ? Math.round((stats.success + stats.fail + stats.excluded) / stats.total * 100) : 0}%` }} /></div>
          </section>

          <section className="card">
            <div className="sectionHead">
              <h2>5. 결과 확인</h2>
              <div className="inline wrap">
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {['전체', '성공', '실패', '대기', '중단됨', '제외'].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <input placeholder="검색" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>선택</th><th>상태</th><th>순번</th><th>등기번호</th><th>고객번호</th><th>배달상태</th><th>상태기준일자</th><th>시간</th><th>우체국</th><th>배달/반송일자</th><th>실패사유</th><th>조회시각</th><th>제외</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => (
                    <tr key={r.rowId} className={selectedRowId === r.rowId ? 'selected' : ''}>
                      <td><input type="radio" name="selectedRow" checked={selectedRowId === r.rowId} onChange={() => setSelectedRowId(r.rowId)} /></td>
                      <td><span className={`pill ${statusClass(r.workStatus)}`}>{r.workStatus}</span></td>
                      <td>{r.seq}</td><td>{r.trackingNo}</td><td>{r.internalId}</td><td>{r.deliveryStatus}</td><td>{r.lastDate}</td><td>{r.lastTime}</td><td>{r.postOffice}</td><td>{r.deliveryDate}</td><td className="failText">{r.failReason}</td><td>{r.checkedAt}</td>
                      <td><button className="small" onClick={() => toggleExclude(r.rowId)}>{r.workStatus === '제외' ? '복원' : '제외'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleRows.length >= 500 && <p className="hint">화면 성능을 위해 500행까지만 표시합니다. CSV에는 전체가 출력됩니다.</p>}
          </section>

          <section className="card">
            <h2>6. CSV 출력</h2>
            <div className="inline wrap">
              <button className="primary" onClick={() => downloadCsv('all')}>전체 결과 CSV</button>
              <button onClick={() => downloadCsv('success')}>성공 건 CSV</button>
              <button onClick={() => downloadCsv('fail')}>실패 건 CSV</button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
