/* CQA data access. The only file that knows where the data lives.

   Default backend: server.py (same origin, /api/...), which reads and writes the files of the project folder.
   Dynamics 365: keep the rest of the app as is and replace these functions, e.g. with Xrm.WebApi calls
   (window.parent.Xrm inside an HTML web resource) or with fetch() to a custom API / Power Automate flow.
   Every function returns a Promise with the same shapes server.py returns. */
const API = (() => {
  const base = (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || 'api';
  async function call(method, path, body){
    let res;
    try {
      res = await fetch(`${base}/${path}`, {method, headers: body ? {'Content-Type': 'application/json'} : {},
                                           body: body ? JSON.stringify(body) : undefined, cache: 'no-store'});
    } catch {
      throw new Error('Сервер недоступен. Запустите python server.py и откройте http://127.0.0.1:8000');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
    return data;
  }
  return {
    /* {dialogues, checklist, evaluations, reviews, jobs, config} */
    bootstrap: () => call('GET', 'bootstrap'),
    checklist: () => call('GET', 'checklist'),
    standardChecklist: () => call('GET', 'checklist/standard'),
    /* writes checklists/: one JSON file per criterion; returns the saved checklist with its version */
    saveChecklist: cl => call('PUT', 'checklist', cl),
    evaluations: () => call('GET', 'evaluations'),
    /* runs judge.py for the dialogues with the saved checklist; returns a job, poll it with job() */
    evaluate: ids => call('POST', 'evaluate', {ids}),
    job: id => call('GET', `jobs/${encodeURIComponent(id)}`),
    saveReview: (id, review) => call('PUT', `reviews/${encodeURIComponent(id)}`, review),
  };
})();
