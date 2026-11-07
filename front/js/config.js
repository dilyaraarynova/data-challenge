/* Deployment settings. Loaded first; a host page (e.g. a Dynamics 365 web resource) may define
   window.CQA_CONFIG before this file to override them.
     apiBase      where api.js sends requests (server.py serves the API at ./api)
     openParam    URL query parameter with a conversation_id to open directly (D365 passes custom data in `data`)
*/
window.CQA_CONFIG = Object.assign({apiBase: 'api', openParam: ['id', 'data']}, window.CQA_CONFIG || {});
