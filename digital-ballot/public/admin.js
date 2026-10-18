'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let token = '', open = true;
  const MSG = { unauthorized: 'קוד שגוי.', admin_disabled: 'ממשק הניהול כבוי בשרת (ADMIN_TOKEN לא הוגדר).', rate_limited: 'יותר מדי ניסיונות. נסו מאוחר יותר.' };

  async function call(path, body) {
    const res = await fetch(path, { method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error); e.code = data.error; throw e; }
    return data;
  }
  function render() {
    $('state').textContent = open ? 'פתוחה' : 'סגורה';
    $('toggle').textContent = open ? 'סיום הסקר (סגירת ההצבעה)' : 'הפעלת הסקר (פתיחת ההצבעה)';
  }
  $('login').addEventListener('submit', async (e) => {
    e.preventDefault(); token = $('tok').value; $('tok').value = '';
    try { const r = await call('/api/admin/check'); open = r.open; $('login').hidden = true; $('panel').hidden = false; $('msg').textContent = ''; render(); }
    catch (err) { token = ''; $('msg').textContent = MSG[err.code] || 'שגיאה.'; }
  });
  $('toggle').addEventListener('click', async () => {
    try { open = (await call('/api/admin/status', { open: !open })).open; render(); $('msg').textContent = 'עודכן.'; }
    catch (err) { $('msg').textContent = MSG[err.code] || 'שגיאה.'; }
  });
  $('reset').addEventListener('click', async () => {
    if (!confirm('למחוק את כל הקולות? פעולה זו אינה הפיכה.')) return;
    try { await call('/api/admin/reset', { confirm: 'RESET' }); $('msg').textContent = 'הסקר אופס.'; }
    catch (err) { $('msg').textContent = MSG[err.code] || 'שגיאה.'; }
  });
})();
