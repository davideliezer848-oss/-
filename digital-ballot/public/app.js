'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const screens = ['intro', 'booth', 'confirm', 'send', 'thanks', 'error', 'results'];
  const nf = new Intl.NumberFormat('he-IL');
  const SPECIAL_LABEL = { blank: 'פתק לבן', undecided: 'עדיין לא החלטתי' };

  let parties = [];
  let open = true;
  let choice = null;          // kept in memory only: never written to URL, storage or logs
  let ticket = null;
  let pollTimer = null;
  let lastFocusScreen = null;

  function show(name) {
    screens.forEach((s) => $('s-' + s).classList.toggle('active', s === name));
    lastFocusScreen = name;
    const h = $('s-' + name).querySelector('h1,h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    clearInterval(pollTimer);
    if (name === 'results') { loadResults(); pollTimer = setInterval(loadResults, 5000); }
    // The hash only ever says which screen is visible – never a choice.
    const wantHash = name === 'results' ? '#results' : '';
    if (location.hash !== wantHash) history.replaceState(null, '', location.pathname + wantHash);
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ cache: 'no-store', credentials: 'omit' }, opts));
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { const e = new Error(data.error || 'request_failed'); e.code = data.error || 'request_failed'; throw e; }
    return data;
  }

  const ERRORS = {
    closed: 'ההצבעה סגורה כרגע.',
    rate_limited: 'בוצעו יותר מדי ניסיונות מהרשת שלכם. נסו שוב מאוחר יותר.',
    too_fast: 'הפעולה התבצעה מהר מדי. נסו שוב בעוד רגע.',
    used_ticket: 'הפתק כבר הוכנס לקלפי. כדי להצביע שוב יש להתחיל מחדש.',
    expired_ticket: 'הזמן שהוקצה להצבעה פג. חזרו לקלפי ונסו שוב.',
    invalid_ticket: 'לא ניתן היה לאמת את ההצבעה. חזרו לקלפי ונסו שוב.',
    invalid_choice: 'הבחירה אינה תקינה. חזרו לקלפי ובחרו שוב.',
    default: 'אירעה תקלה בחיבור לשרת. הבחירה שלכם לא נשמרה. נסו שוב.'
  };
  let retryFn = null;
  function fail(err, retry) {
    $('errMsg').textContent = ERRORS[err && err.code] || ERRORS.default;
    retryFn = retry || null;
    $('errRetry').hidden = !retryFn;
    show('error');
  }

  function sortedParties() {
    return parties.slice().sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  function slipEl(p, big) {
    const el = document.createElement(big ? 'div' : 'button');
    el.className = 'slip' + (big ? ' big-slip' : '') + (p.id === 'blank' ? ' blank' : '');
    if (!big) { el.type = 'button'; el.setAttribute('role', 'listitem'); el.setAttribute('aria-label', p.letters ? `${p.name}, אותיות ${p.letters}` : p.name); }
    const l = document.createElement('div'); l.className = 'letters'; l.textContent = p.letters || '';
    const n = document.createElement('div'); n.className = 'pname'; n.textContent = p.name;
    el.append(l, n);
    return el;
  }

  function renderSlips() {
    const wrap = $('slips'); wrap.textContent = '';
    sortedParties().forEach((p) => {
      const el = slipEl(p, false);
      el.addEventListener('click', () => pick(p, el));
      wrap.appendChild(el);
    });
    const blank = slipEl({ id: 'blank', name: 'פתק לבן', letters: '' }, false);
    blank.addEventListener('click', () => pick({ id: 'blank', name: 'פתק לבן', letters: '' }, blank));
    wrap.appendChild(blank);
  }

  function pick(p, el) {
    choice = p;
    if (el) el.classList.add('picked');
    setTimeout(() => {
      const chosen = $('chosenSlip'); chosen.textContent = '';
      const big = slipEl(p, true); big.classList.toggle('undecided', p.id === 'undecided');
      chosen.replaceWith(big); big.id = 'chosenSlip'; big.setAttribute('aria-live', 'polite');
      if (el) el.classList.remove('picked');
      show('confirm');
      $('confirm').focus();
    }, el ? 380 : 0);
  }

  async function startBooth() {
    if (!open) return;
    ticket = null; choice = null;
    show('booth');
    try { ticket = (await api('/api/ticket', { method: 'POST' })).ticket; } catch (e) { fail(e, startBooth); }
  }

  async function submitVote() {
    if (!choice) return show('booth');
    show('send');
    const stage = $('stage');
    const env = $('env');
    stage.classList.remove('waiting'); env.style.animation = 'none'; void env.offsetWidth; env.style.animation = '';
    $('sendStatus').textContent = 'מכניס את הפתק למעטפה…';
    const animation = new Promise((r) => setTimeout(r, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 3300));
    let result;
    try {
      if (!ticket) ticket = (await api('/api/ticket', { method: 'POST' })).ticket;
      await Promise.all([
        api('/api/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, choice: choice.id }) }),
        animation
      ]);
      result = 'ok';
    } catch (e) { result = e; }
    if (result === 'ok') {
      ticket = null; choice = null;             // forget the choice immediately
      $('chosenSlip').textContent = '';
      show('thanks');
    } else {
      // Network error: the ticket was not consumed by a successful vote, so a retry is safe. Other errors need a fresh start.
      const retryable = result.code === 'too_fast' || !result.code || result.code === 'request_failed';
      if (!retryable) { ticket = null; }
      fail(result, retryable ? () => (choice ? show('confirm') : startBooth()) : startBooth);
    }
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function loadResults() {
    try {
      const r = await api('/api/results');
      const total = r.total;
      $('total').textContent = nf.format(total);
      $('updated').textContent = fmtTime(r.updatedAt);
      const empty = $('empty'), bars = $('bars'), side = $('sideRows');
      bars.textContent = ''; side.textContent = '';
      if (total === 0) {
        empty.hidden = false;
        empty.textContent = r.open ? 'טרם התקבלו הצבעות' : 'ההצבעה טרם החלה או נסגרה, וטרם התקבלו הצבעות';
        return;
      }
      empty.hidden = true;
      const rows = parties
        .map((p) => ({ p, c: r.counts[p.id] || 0 }))
        .filter((x) => x.c > 0)
        .sort((a, b) => b.c - a.c || a.p.name.localeCompare(b.p.name, 'he'));
      const maxC = rows.length ? rows[0].c : 1;
      rows.forEach((x, i) => {
        const li = document.createElement('li'); li.className = 'bar';
        const pct = (x.c / total) * 100;
        li.innerHTML = '<div class="rank"></div><div class="bar-body"><div class="bar-top"><span class="bar-name"></span><span class="bar-val"></span></div><div class="track"><div class="fill"></div></div></div>';
        li.querySelector('.rank').textContent = i + 1;
        const name = li.querySelector('.bar-name'); name.textContent = x.p.name;
        const sm = document.createElement('small'); sm.textContent = x.p.letters; name.appendChild(sm);
        const val = li.querySelector('.bar-val'); val.textContent = pct.toFixed(1) + '% ';
        const c = document.createElement('small'); c.textContent = '(' + nf.format(x.c) + ' קולות)'; val.appendChild(c);
        const fill = li.querySelector('.fill'); fill.setAttribute('role', 'img'); fill.setAttribute('aria-label', pct.toFixed(1) + ' אחוז');
        bars.appendChild(li);
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (x.c / maxC) * 100 + '%'; }));
      });
      ['blank', 'undecided'].forEach((id) => {
        const c = r.counts[id] || 0; if (!c) return;
        const d = document.createElement('div'); d.className = 'side';
        const a = document.createElement('span'); a.textContent = SPECIAL_LABEL[id];
        const b = document.createElement('span'); b.textContent = ((c / total) * 100).toFixed(1) + '% ';
        const s = document.createElement('small'); s.textContent = '(' + nf.format(c) + ')'; b.appendChild(s);
        d.append(a, b); side.appendChild(d);
      });
    } catch (e) {
      $('empty').hidden = false; $('empty').textContent = 'לא ניתן לטעון את התוצאות כרגע. נסו לרענן את הדף.';
    }
  }

  async function init() {
    try {
      const cfg = await api('/api/config');
      parties = cfg.parties; open = cfg.open;
      const c = cfg.config || {};
      if (c.accent) document.documentElement.style.setProperty('--accent', c.accent);
      if (c.ink) document.documentElement.style.setProperty('--ink', c.ink);
      $('brandName').textContent = c.brandName || 'הקלפי הדיגיטלי';
      if (c.logoPath) {
        const img = new Image(); img.alt = c.brandName || ''; img.src = c.logoPath;
        img.onload = () => { $('brand').textContent = ''; $('brand').appendChild(img); };
      }
    } catch (e) { return fail(e, () => location.reload()); }
    renderSlips();
    $('enter').disabled = !open;
    $('closedNote').hidden = open;
    if (location.hash === '#results') show('results');
  }

  $('enter').addEventListener('click', startBooth);
  $('pickUndecided').addEventListener('click', () => pick({ id: 'undecided', name: 'עדיין לא החלטתי', letters: '' }, null));
  $('back').addEventListener('click', () => show('booth'));
  $('confirm').addEventListener('click', submitVote);
  $('toResults').addEventListener('click', () => show('results'));
  $('toResultsTop').addEventListener('click', () => show('results'));
  $('resHome').addEventListener('click', () => show('intro'));
  $('errHome').addEventListener('click', () => show('intro'));
  $('errRetry').addEventListener('click', () => retryFn && retryFn());
  window.addEventListener('hashchange', () => { if (location.hash === '#results') show('results'); });
  init();
})();
